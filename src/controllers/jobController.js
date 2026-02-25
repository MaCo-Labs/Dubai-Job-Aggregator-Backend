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

                const existing = await Company.findOne({
                    name: { $regex: new RegExp(`^${companyData.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
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

// Start scraping all companies
exports.scrapeAll = async (req, res, next) => {
    try {
        const companies = await Company.find({});
        if (companies.length === 0) {
            return res.status(400).json({ error: 'No companies found. Upload an XLSX file first.' });
        }

        // Mark all as pending
        await Company.updateMany({}, { scrapeStatus: 'pending' });

        res.json({
            message: `Scraping started for ${companies.length} companies`,
            status: 'started',
        });

        // Run scraping in background
        scrapeAllCompanies().catch((err) => {
            logger.error(`Background scrape error: ${err.message}`);
        });
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
        const totalCompanies = await Company.countDocuments();
        const totalJobs = await Job.countDocuments({ isActive: true });
        const companiesScraped = await Company.countDocuments({
            scrapeStatus: { $in: ['completed', 'no_jobs_found'] },
        });
        const companiesPending = await Company.countDocuments({
            scrapeStatus: { $in: ['pending', 'scraping'] },
        });
        const companiesFailed = await Company.countDocuments({ scrapeStatus: 'failed' });

        // Discovery stats
        const discoveryFound = await Company.countDocuments({ discoveryStatus: 'found' });
        const discoveryPending = await Company.countDocuments({
            discoveryStatus: { $in: ['pending', 'searching'] },
        });
        const discoveryNotFound = await Company.countDocuments({ discoveryStatus: 'not_found' });

        const industriesAgg = await Job.aggregate([
            { $match: { isActive: true } },
            { $group: { _id: '$industry', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]);

        // Tower stats
        const towerAgg = await Company.aggregate([
            { $match: { tower: { $ne: null } } },
            { $group: { _id: '$tower', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]);

        res.json({
            totalCompanies,
            totalJobs,
            companiesScraped,
            companiesPending,
            companiesFailed,
            discoveryFound,
            discoveryPending,
            discoveryNotFound,
            industries: industriesAgg,
            towers: towerAgg,
        });
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
