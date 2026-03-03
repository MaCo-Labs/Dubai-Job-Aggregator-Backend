const Company = require('../models/Company');
const Job = require('../models/Job');
const { parseXLSX } = require('../services/xlsxParser');
const { scrapeCompany, scrapeAllCompanies } = require('../services/scraperService');
const { discoverCompanyUrls, discoverAllCompanies } = require('../services/discoveryService');
const logger = require('../config/logger');
const path = require('path');
const fs = require('fs');

// Upload XLSX and parse companies (multi-sheet with tower support)
exports.uploadCompanies = async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded. Please upload an XLSX file.' });
        }

        const filePath = req.file.path;
        const companies = parseXLSX(filePath);

        // Upsert companies into database
        const results = { created: 0, updated: 0, errors: [], towers: [] };
        const towersSet = new Set();

        for (const companyData of companies) {
            try {
                if (companyData.tower) towersSet.add(companyData.tower);

                const safeName = companyData.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const existing = await Company.findOne({
                    name: { $regex: new RegExp(`^${safeName}$`, 'i') },
                    tower: companyData.tower || null,
                });

                if (existing) {
                    await Company.findByIdAndUpdate(existing._id, {
                        ...companyData,
                        scrapeStatus: 'pending',
                        // Don't overwrite existing URLs if the new data doesn't have them
                        ...(companyData.websiteUrl ? { websiteUrl: companyData.websiteUrl } : {}),
                        ...(companyData.linkedinUrl ? { linkedinUrl: companyData.linkedinUrl } : {}),
                    });
                    results.updated++;
                } else {
                    await Company.create({
                        ...companyData,
                        scrapeStatus: 'pending',
                        discoveryStatus: companyData.websiteUrl ? 'skipped' : 'pending',
                    });
                    results.created++;
                }
            } catch (err) {
                results.errors.push({ company: companyData.name, error: err.message });
            }
        }

        results.towers = [...towersSet];

        // Clean up uploaded file
        try {
            fs.unlinkSync(filePath);
        } catch { }

        const allCompanies = await Company.find({}).sort({ tower: 1, name: 1 });

        res.json({
            message: `Processed ${companies.length} companies from ${results.towers.length} towers`,
            results,
            companies: allCompanies,
        });
    } catch (error) {
        next(error);
    }
};

// Discover URLs for all companies (uses ChatGPT)
exports.discoverAll = async (req, res, next) => {
    try {
        const companies = await Company.find({
            $or: [
                { websiteUrl: { $in: [null, ''] } },
                { linkedinUrl: { $in: [null, ''] } },
            ],
        });

        if (companies.length === 0) {
            return res.json({
                message: 'All companies already have URLs discovered',
                status: 'complete',
            });
        }

        res.json({
            message: `Discovery started for ${companies.length} companies`,
            status: 'started',
            count: companies.length,
        });

        // Run in background
        discoverAllCompanies().catch((err) => {
            logger.error(`Background discovery error: ${err.message}`);
        });
    } catch (error) {
        next(error);
    }
};

// Discover URLs for a single company
exports.discoverOne = async (req, res, next) => {
    try {
        const company = await Company.findById(req.params.companyId);
        if (!company) {
            return res.status(404).json({ error: 'Company not found' });
        }

        res.json({ message: `Discovery started for ${company.name}`, status: 'started' });

        discoverCompanyUrls(company).catch((err) => {
            logger.error(`Discovery error for ${company.name}: ${err.message}`);
        });
    } catch (error) {
        next(error);
    }
};

// Start scraping all companies (with smart discovery and skip logic)
exports.scrapeAll = async (req, res, next) => {
    try {
        const { force = false } = req.query;
        const companies = await Company.find({});

        if (companies.length === 0) {
            return res.status(400).json({ error: 'No companies found. Upload an XLSX file first.' });
        }

        // 1. Find companies that need discovery
        const needsDiscovery = companies.filter(c => !c.websiteUrl && !c.linkedinUrl);

        // 2. Determine which companies to scrape
        const toScrapeQuery = force === 'true'
            ? {}
            : { scrapeStatus: { $in: ['pending', 'failed', 'scraping'] } };

        // 3. Get the actual list of companies to scrape
        const companiesToScrape = await Company.find(toScrapeQuery);

        res.json({
            message: `Scraping workflow started for ${companiesToScrape.length} companies. ${needsDiscovery.length} need discovery first.`,
            status: 'started',
            scrapeCount: companiesToScrape.length,
            discoveryCount: needsDiscovery.length,
            forceMode: force === 'true'
        });

        // Run workflow in background
        (async () => {
            try {
                // Step A: Mark target companies as 'scraping' immediately for UI feedback
                const targetIds = companiesToScrape.map(c => c._id);
                await Company.updateMany(
                    { _id: { $in: targetIds } },
                    { scrapeStatus: 'scraping' }
                );

                // Step B: Discovery for those missing URLs
                if (needsDiscovery.length > 0) {
                    logger.info(`Starting auto-discovery for ${needsDiscovery.length} companies before scraping`);
                    await discoverAllCompanies({
                        _id: { $in: needsDiscovery.map(c => c._id) }
                    });
                }

                // Step C: Run scraping one by one
                logger.info(`Starting sequential scraping for ${companiesToScrape.length} companies...`);
                await scrapeAllCompanies(toScrapeQuery);
            } catch (err) {
                logger.error(`Background scrape workflow error: ${err.message}`);
            }
        })();
    } catch (error) {
        next(error);
    }
};

// Scrape a single company
exports.scrapeOne = async (req, res, next) => {
    try {
        const company = await Company.findById(req.params.companyId);
        if (!company) {
            return res.status(404).json({ error: 'Company not found' });
        }

        res.json({ message: `Scraping started for ${company.name}`, status: 'started' });

        scrapeCompany(company).catch((err) => {
            logger.error(`Scrape error for ${company.name}: ${err.message}`);
        });
    } catch (error) {
        next(error);
    }
};

// Get all jobs with filters (including tower filter)
exports.getJobs = async (req, res, next) => {
    try {
        const {
            page = 1,
            limit = 20,
            search,
            industry,
            company,
            location,
            tower,
            sort = '-createdAt',
        } = req.query;

        const filter = { isActive: true };

        if (search) {
            filter.$or = [
                { title: { $regex: search, $options: 'i' } },
                { companyName: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } },
            ];
        }
        if (industry) filter.industry = { $regex: industry, $options: 'i' };
        if (company) filter.companyName = { $regex: company, $options: 'i' };
        if (location) filter.location = { $regex: location, $options: 'i' };
        if (tower) filter.tower = { $regex: tower, $options: 'i' };

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const total = await Job.countDocuments(filter);
        const jobs = await Job.find(filter)
            .sort(sort)
            .skip(skip)
            .limit(parseInt(limit))
            .populate('company', 'name websiteUrl linkedinUrl industry tower');

        res.json({
            jobs,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit)),
            },
        });
    } catch (error) {
        next(error);
    }
};

// Get single job
exports.getJob = async (req, res, next) => {
    try {
        const job = await Job.findById(req.params.id).populate('company');
        if (!job) return res.status(404).json({ error: 'Job not found' });
        res.json(job);
    } catch (error) {
        next(error);
    }
};

// Get all companies with optional tower filter
exports.getCompanies = async (req, res, next) => {
    try {
        const { tower } = req.query;
        const filter = {};
        if (tower) filter.tower = { $regex: tower, $options: 'i' };

        const companies = await Company.find(filter).sort({ tower: 1, name: 1 });

        // Simple ETag based on length and last update
        const lastUpdate = companies.reduce((max, c) => Math.max(max, new Date(c.updatedAt).getTime()), 0);
        const etag = `W/"${companies.length}-${lastUpdate}"`;

        if (req.header('If-None-Match') === etag) {
            return res.status(304).end();
        }

        res.setHeader('ETag', etag);
        res.json(companies);
    } catch (error) {
        next(error);
    }
};

// Get list of all towers
exports.getTowers = async (req, res, next) => {
    try {
        const towers = await Company.distinct('tower');
        const towerList = towers.filter(Boolean).sort();
        res.json(towerList);
    } catch (error) {
        next(error);
    }
};

// Get dashboard stats
exports.getStats = async (req, res, next) => {
    try {
        const stats = {
            totalCompanies: await Company.countDocuments(),
            totalJobs: await Job.countDocuments({ isActive: true }),
            companiesScraped: await Company.countDocuments({
                scrapeStatus: { $in: ['completed', 'no_jobs_found'] },
            }),
            companiesPending: await Company.countDocuments({
                scrapeStatus: { $in: ['pending', 'scraping'] },
            }),
            companiesFailed: await Company.countDocuments({ scrapeStatus: 'failed' }),
            discoveryFound: await Company.countDocuments({ discoveryStatus: 'found' }),
            discoveryPending: await Company.countDocuments({
                discoveryStatus: { $in: ['pending', 'searching'] },
            }),
            discoveryNotFound: await Company.countDocuments({ discoveryStatus: 'not_found' }),
        };

        // Aggregations
        stats.industries = await Job.aggregate([
            { $match: { isActive: true } },
            { $group: { _id: '$industry', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]);

        stats.towers = await Company.aggregate([
            { $match: { tower: { $ne: null } } },
            { $group: { _id: '$tower', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]);

        // Calculate a "last update" timestamp for stats
        const lastCompanyUpdate = await Company.findOne({}).sort({ updatedAt: -1 }).select('updatedAt');
        const lastJobUpdate = await Job.findOne({}).sort({ updatedAt: -1 }).select('updatedAt');

        const lastUpdate = Math.max(
            lastCompanyUpdate ? new Date(lastCompanyUpdate.updatedAt).getTime() : 0,
            lastJobUpdate ? new Date(lastJobUpdate.updatedAt).getTime() : 0
        );

        // ETag based on stats values and last update
        const etag = `W/"${JSON.stringify(stats).length}-${stats.totalJobs}-${stats.companiesScraped}-${lastUpdate}"`;

        if (req.header('If-None-Match') === etag) {
            return res.status(304).end();
        }

        res.setHeader('ETag', etag);
        res.json(stats);
    } catch (error) {
        next(error);
    }
};

// Delete all data (reset)
exports.resetData = async (req, res, next) => {
    try {
        await Job.deleteMany({});
        await Company.deleteMany({});
        res.json({ message: 'All data has been reset' });
    } catch (error) {
        next(error);
    }
};
