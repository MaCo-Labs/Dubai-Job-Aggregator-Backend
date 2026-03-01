const axios = require('axios');
const cheerio = require('cheerio');
const logger = require('../config/logger');
const { generateHash } = require('../utils/hashGenerator');
const Job = require('../models/Job');
const Company = require('../models/Company');
const { discoverCompanyUrls } = require('./discoveryService');

let sharedBrowser = null;
const puppeteer = require('puppeteer');

// Common career page paths to try
const CAREER_PATHS = [
    '/careers',
    '/jobs',
    '/career',
    '/join-us',
    '/join',
    '/work-with-us',
    '/opportunities',
    '/vacancies',
    '/openings',
    '/hiring',
    '/en/careers',
    '/en/jobs',
    '/about/careers',
    '/about/jobs',
    '/company/careers',
];

// Keywords that indicate a job listing link
const JOB_KEYWORDS = [
    'career', 'job', 'opening', 'vacancy', 'position', 'hiring',
    'opportunity', 'join', 'work', 'recruit', 'employment', 'apply',
];

// Keywords that indicate a job title or job listing text
const JOB_TITLE_PATTERNS = [
    // Role keywords
    /manager/i, /engineer/i, /developer/i, /analyst/i, /designer/i,
    /consultant/i, /specialist/i, /coordinator/i, /director/i, /lead/i,
    /officer/i, /executive/i, /administrator/i, /architect/i, /supervisor/i,
    /technician/i, /assistant/i, /associate/i, /intern/i, /accountant/i,
    /advisor/i, /representative/i, /sales/i, /marketing/i, /support/i,
    /head of/i, /senior/i, /junior/i, /sr\./i, /jr\./i, /vp/i,
    // More roles
    /nurse/i, /pharmacist/i, /doctor/i, /therapist/i, /trainer/i,
    /chef/i, /driver/i, /receptionist/i, /cashier/i, /cleaner/i,
    /plumber/i, /electrician/i, /mechanic/i, /operator/i, /handler/i,
    /inspector/i, /auditor/i, /buyer/i, /purchas/i, /procurement/i,
    /logistics/i, /warehouse/i, /foreman/i, /surveyor/i, /estimator/i,
    /finance/i, /human resource/i, /\bhr\b/i, /\bit\b/i, /network/i,
    /security/i, /safety/i, /quality/i, /compliance/i, /legal/i,
    /secretary/i, /clerk/i, /data entry/i, /customer service/i,
    /healthcare/i, /medical/i, /dental/i, /optician/i, /veterinar/i,
    /managerial/i, /candidate/i, /teacher/i, /instructor/i, /tutor/i,
    /researcher/i, /scientist/i, /professor/i, /lecturer/i,
    // Career page phrases that indicate a job listing
    /apply for/i, /position of/i, /we are hiring/i, /looking for/i,
    /open position/i, /job opening/i, /\brole\b/i, /vacancy/i,
];

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * Attempt to find the career page URL for a company
 */
const findCareerPage = async (baseUrl) => {
    if (!baseUrl) return null;

    // Remove trailing slash
    const base = baseUrl.replace(/\/+$/, '');

    const results = await Promise.all(CAREER_PATHS.slice(0, 10).map(async (path) => {
        try {
            const url = base + path;
            const response = await axios.get(url, {
                headers: { 'User-Agent': USER_AGENT },
                timeout: 8000,
                maxRedirects: 5,
                validateStatus: (status) => status < 400,
            });
            if (response.status === 200) {
                return url;
            }
        } catch {
            return null;
        }
        return null;
    }));

    const foundCareer = results.find(r => r !== null);
    if (foundCareer) {
        logger.info(`Found career page: ${foundCareer}`);
        return foundCareer;
    }

    // Try remaining paths if not found in first batch
    if (CAREER_PATHS.length > 10) {
        const remainingResults = await Promise.all(CAREER_PATHS.slice(10).map(async (path) => {
            try {
                const url = base + path;
                const response = await axios.get(url, {
                    headers: { 'User-Agent': USER_AGENT },
                    timeout: 8000,
                    maxRedirects: 5,
                    validateStatus: (status) => status < 400,
                });
                if (response.status === 200) {
                    return url;
                }
            } catch {
                return null;
            }
            return null;
        }));
        const foundRemaining = remainingResults.find(r => r !== null);
        if (foundRemaining) {
            logger.info(`Found career page in secondary batch: ${foundRemaining}`);
            return foundRemaining;
        }
    }

    // Try to find career link on main page
    try {
        const response = await axios.get(base, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 10000,
        });
        const $ = cheerio.load(response.data);
        let careerUrl = null;

        $('a').each((_, el) => {
            const href = $(el).attr('href') || '';
            const text = $(el).text().toLowerCase();
            const hrefLower = href.toLowerCase();

            if (
                JOB_KEYWORDS.some((kw) => text.includes(kw) || hrefLower.includes(kw))
            ) {
                if (href.startsWith('http')) {
                    careerUrl = href;
                } else if (href.startsWith('/')) {
                    careerUrl = base + href;
                }
                return false; // break
            }
        });

        if (careerUrl) {
            logger.info(`Found career link on main page: ${careerUrl}`);
            return careerUrl;
        }
    } catch (err) {
        logger.warn(`Could not fetch main page for ${base}: ${err.message}`);
    }

    return null;
};

/**
 * Get or create a shared browser instance
 */
const getBrowser = async () => {
    if (sharedBrowser) {
        try {
            // Check if browser is still responsive
            await sharedBrowser.version();
            return sharedBrowser;
        } catch (e) {
            logger.warn('Shared browser disconnected, restarting...');
            sharedBrowser = null;
        }
    }

    sharedBrowser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-features=IsolateOrigins,site-per-process'
        ],
    });

    sharedBrowser.on('disconnected', () => {
        sharedBrowser = null;
    });

    return sharedBrowser;
};

/**
 * Extract job listings from a career page using Cheerio
 */
const scrapeWithCheerio = async (url) => {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 8000,
        });
        const $ = cheerio.load(response.data);
        const jobs = [];

        // Strategy 0: Find elements that contain or are near "Apply" buttons/links
        // This catches career pages like Life Pharmacy that show cards with "Apply Now" buttons
        $('a, button').each((_, el) => {
            const btnText = $(el).text().trim().toLowerCase();
            if (btnText.includes('apply')) {
                // Look at the parent container for the job title
                const $parent = $(el).parent();
                const $container = $parent.closest('div, li, article, section, .card, [class*="card"], [class*="item"]').first();
                const container = $container.length ? $container : $parent;

                // Get all text from the container, excluding the Apply button text
                const allText = container.clone().find('a, button').filter((_, e) => {
                    return $(e).text().trim().toLowerCase().includes('apply');
                }).remove().end().end().text().trim();

                // Get the heading or prominent text
                let title = '';
                const headings = container.find('h1, h2, h3, h4, h5, h6, p, span, div');
                headings.each((_, h) => {
                    const t = $(h).text().trim();
                    if (t.length > 5 && t.length < 200 && !t.toLowerCase().includes('apply now')) {
                        if (!title || t.length > title.length) title = t;
                    }
                });

                // Fallback: use the container text minus "Apply Now"
                if (!title && allText.length > 5) {
                    title = allText.replace(/apply\s*now/gi, '').trim();
                }

                if (title && title.length > 4 && title.length < 200) {
                    const link = extractLink($, container, url);
                    jobs.push({ title: title.trim(), location: '', applyUrl: link, description: '' });
                }
            }
        });

        // Strategy 1: Look for common job listing patterns
        if (jobs.length === 0) {
            const jobSelectors = [
                '.job-listing', '.job-item', '.career-item', '.vacancy',
                '.opening', '.position', '[class*="job"]', '[class*="career"]',
                '[class*="vacancy"]', '[class*="position"]', '[class*="opening"]',
                'article', '.card', '.list-item',
            ];

            for (const selector of jobSelectors) {
                $(selector).each((_, el) => {
                    const $el = $(el);
                    const title = extractTitle($, $el);
                    const location = extractLocation($, $el);
                    const link = extractLink($, $el, url);
                    const description = $el.text().trim().substring(0, 500);

                    if (title && isLikelyJobTitle(title)) {
                        jobs.push({ title, location, applyUrl: link, description });
                    }
                });
                if (jobs.length > 0) break;
            }
        }

        // Strategy 2: Look for links with job-like text
        if (jobs.length === 0) {
            $('a').each((_, el) => {
                const text = $(el).text().trim();
                const href = $(el).attr('href') || '';

                if (text.length > 5 && text.length < 150 && isLikelyJobTitle(text)) {
                    const link = href.startsWith('http')
                        ? href
                        : href.startsWith('/')
                            ? new URL(href, url).href
                            : null;

                    jobs.push({
                        title: text,
                        location: '',
                        applyUrl: link,
                        description: '',
                    });
                }
            });
        }

        // Strategy 3: Look for headings that could be job titles
        if (jobs.length === 0) {
            $('h1, h2, h3, h4, h5').each((_, el) => {
                const text = $(el).text().trim();
                if (text.length > 5 && text.length < 150 && isLikelyJobTitle(text)) {
                    const parentLink = $(el).closest('a').attr('href') || $(el).find('a').attr('href') || '';
                    const link = parentLink.startsWith('http')
                        ? parentLink
                        : parentLink.startsWith('/')
                            ? new URL(parentLink, url).href
                            : url;

                    jobs.push({
                        title: text,
                        location: '',
                        applyUrl: link,
                        description: '',
                    });
                }
            });
        }

        // Strategy 4: On a known career page, extract ALL prominent text blocks
        // as potential job listings (broader fallback)
        if (jobs.length === 0) {
            const pageText = $('body').text().toLowerCase();
            const isCareerPage = /career|job|opening|vacanc|position|hiring|recruit/i.test(pageText);

            if (isCareerPage) {
                $('h2, h3, h4, h5, p, li, div > span').each((_, el) => {
                    const text = $(el).text().trim();
                    const children = $(el).children().length;

                    // Only leaf-ish elements with reasonable text length
                    if (text.length > 8 && text.length < 150 && children < 3) {
                        if (isLikelyJobTitle(text)) {
                            const parentLink = $(el).closest('a').attr('href') || '';
                            const link = parentLink.startsWith('http')
                                ? parentLink
                                : parentLink.startsWith('/')
                                    ? new URL(parentLink, url).href
                                    : url;

                            jobs.push({ title: text, location: '', applyUrl: link, description: '' });
                        }
                    }
                });
            }
        }

        // Deduplicate by title
        const unique = [];
        const seen = new Set();
        for (const job of jobs) {
            const key = job.title.toLowerCase().trim();
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(job);
            }
        }

        return unique;
    } catch (error) {
        logger.warn(`Cheerio scrape failed for ${url}: ${error.message}`);
        return [];
    }
};

/**
 * Scrape a page using Puppeteer for JS-rendered content
 */
const scrapeWithPuppeteer = async (url) => {
    let page = null;
    try {
        const browser = await getBrowser();
        page = await browser.newPage();
        await page.setUserAgent(USER_AGENT);
        await page.setViewport({ width: 1366, height: 768 });
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait for dynamic content to render with a shorter timeout or specific indicator
        await new Promise((r) => setTimeout(r, 2000));

        const html = await page.content();
        const $ = cheerio.load(html);
        const jobs = [];

        // Extract job listings from rendered page
        $('a').each((_, el) => {
            const text = $(el).text().trim();
            const href = $(el).attr('href') || '';

            if (text.length > 5 && text.length < 150 && isLikelyJobTitle(text)) {
                const link = href.startsWith('http')
                    ? href
                    : href.startsWith('/')
                        ? new URL(href, url).href
                        : null;

                jobs.push({
                    title: text,
                    location: '',
                    applyUrl: link,
                    description: '',
                });
            }
        });

        // Also check headings
        $('h1, h2, h3, h4, h5').each((_, el) => {
            const text = $(el).text().trim();
            if (text.length > 5 && text.length < 150 && isLikelyJobTitle(text)) {
                jobs.push({
                    title: text,
                    location: '',
                    applyUrl: url,
                    description: '',
                });
            }
        });

        // Deduplicate
        const unique = [];
        const seen = new Set();
        for (const job of jobs) {
            const key = job.title.toLowerCase().trim();
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(job);
            }
        }

        return unique;
    } catch (error) {
        logger.warn(`Puppeteer scrape failed for ${url}: ${error.message}`);
        return [];
    } finally {
        if (page) {
            try {
                await page.close();
            } catch (e) {
                // Ignore page close errors
            }
        }
    }
};

/**
 * Scrape a single company for job openings
 */
const scrapeCompany = async (company) => {
    logger.info(`Scraping jobs for: ${company.name}`);

    try {
        // Update status to scraping
        await Company.findByIdAndUpdate(company._id, { scrapeStatus: 'scraping' });

        // Step 1: Discover URLs if missing
        if (!company.websiteUrl && !company.linkedinUrl) {
            logger.info(`${company.name}: No URLs found, running discovery...`);
            const discovered = await discoverCompanyUrls(company);
            if (discovered.websiteUrl) {
                company.websiteUrl = discovered.websiteUrl;
            }
            if (discovered.linkedinUrl) {
                company.linkedinUrl = discovered.linkedinUrl;
            }
        }

        // Step 2: Find career page
        let careerUrl = company.careerPageUrl;
        if (!careerUrl && company.websiteUrl) {
            careerUrl = await findCareerPage(company.websiteUrl);
            if (careerUrl) {
                await Company.findByIdAndUpdate(company._id, { careerPageUrl: careerUrl });
            }
        }

        if (!careerUrl) {
            logger.warn(`No career page found for ${company.name}`);
            await Company.findByIdAndUpdate(company._id, {
                scrapeStatus: 'no_jobs_found',
                lastScrapedAt: new Date(),
                scrapeError: 'Could not find career page',
            });
            return { company: company.name, jobs: [], status: 'no_career_page' };
        }

        // Step 2: Try Cheerio first
        let jobs = await scrapeWithCheerio(careerUrl);

        // Step 3: Fallback to Puppeteer if no results
        if (jobs.length === 0) {
            logger.info(`Cheerio found no jobs for ${company.name}, trying Puppeteer...`);
            try {
                jobs = await scrapeWithPuppeteer(careerUrl);
            } catch (e) {
                logger.warn(`Puppeteer not available or failed: ${e.message}`);
            }
        }

        // Step 4: Save jobs to database
        let savedCount = 0;
        for (const jobData of jobs) {
            const hash = generateHash(jobData.title, company.name, jobData.location);

            try {
                await Job.findOneAndUpdate(
                    { dedupeHash: hash },
                    {
                        $setOnInsert: {
                            title: jobData.title,
                            company: company._id,
                            companyName: company.name,
                            location: jobData.location || 'Dubai, UAE',
                            description: jobData.description,
                            applyUrl: jobData.applyUrl,
                            source: 'website',
                            industry: company.industry,
                            tower: company.tower,
                            dedupeHash: hash,
                            isActive: true,
                        },
                    },
                    { upsert: true, new: true }
                );
                savedCount++;
            } catch (err) {
                if (err.code !== 11000) {
                    logger.error(`Error saving job: ${err.message}`);
                }
            }
        }

        // Update company status
        const status = jobs.length > 0 ? 'completed' : 'no_jobs_found';
        await Company.findByIdAndUpdate(company._id, {
            scrapeStatus: status,
            lastScrapedAt: new Date(),
            jobCount: await Job.countDocuments({ company: company._id, isActive: true }),
            scrapeError: null,
        });

        logger.info(`${company.name}: Found ${jobs.length} jobs, saved ${savedCount} new`);
        return { company: company.name, jobs: jobs.length, saved: savedCount, status };
    } catch (error) {
        logger.error(`Scrape error for ${company.name}: ${error.message}`);
        await Company.findByIdAndUpdate(company._id, {
            scrapeStatus: 'failed',
            lastScrapedAt: new Date(),
            scrapeError: error.message,
        });
        return { company: company.name, jobs: 0, status: 'failed', error: error.message };
    }
};

/**
 * Scrape all companies sequentially with a delay
 */
const scrapeAllCompanies = async (query = {}) => {
    const companies = await Company.find(query);
    const results = [];
    const CONCURRENCY = 10;

    logger.info(`Starting concurrent scraping for ${companies.length} companies (max: ${CONCURRENCY})`);

    let index = 0;
    const workers = Array(Math.min(CONCURRENCY, companies.length)).fill(null).map(async () => {
        while (index < companies.length) {
            const company = companies[index++];
            try {
                const res = await scrapeCompany(company);
                results.push(res);
            } catch (err) {
                logger.error(`Error scraping ${company.name}: ${err.message}`);
                results.push({ company: company.name, status: 'error', error: err.message });
            }
        }
    });

    await Promise.all(workers);

    // Close browser after all scraping is done
    if (sharedBrowser) {
        await sharedBrowser.close();
        sharedBrowser = null;
    }

    return results;
};

// --- Helper Functions ---

function extractTitle($, $el) {
    const titleSelectors = ['h1', 'h2', 'h3', 'h4', 'h5', '.title', '.job-title', '[class*="title"]', 'a'];
    for (const sel of titleSelectors) {
        const text = $el.find(sel).first().text().trim();
        if (text && text.length > 3 && text.length < 150) return text;
    }
    return $el.find('a').first().text().trim() || $el.text().trim().split('\n')[0]?.trim();
}

function extractLocation($, $el) {
    const locSelectors = ['.location', '[class*="location"]', '[class*="city"]', '.meta'];
    for (const sel of locSelectors) {
        const text = $el.find(sel).first().text().trim();
        if (text) return text;
    }
    return '';
}

function extractLink($, $el, baseUrl) {
    const href = $el.find('a').first().attr('href') || $el.closest('a').attr('href') || '';
    if (href.startsWith('http')) return href;
    if (href.startsWith('/')) {
        try {
            return new URL(href, baseUrl).href;
        } catch {
            return baseUrl;
        }
    }
    return baseUrl;
}

function isLikelyJobTitle(text) {
    if (!text || text.length < 4 || text.length > 200) return false;

    // Exclude navigation/UI text
    const excludePatterns = [
        /^(home|about us|contact|menu|login|sign|search|privacy|terms|cookie)/i,
        /^(read more|learn more|view all|see all|load more|show more)/i,
        /^(next|prev|back|close|submit|cancel|ok|yes|no|skip)/i,
        /^(follow us|subscribe|newsletter|copyright|all rights)/i,
        /^(online store|brands|partner)/i,
        /^\d+$/, // pure numbers
        /^[^a-zA-Z]*$/, // no letters
        /^apply\s*now$/i, // just "Apply Now" button text
    ];

    for (const pattern of excludePatterns) {
        if (pattern.test(text.trim())) return false;
    }

    return JOB_TITLE_PATTERNS.some((pattern) => pattern.test(text));
}

module.exports = { scrapeCompany, scrapeAllCompanies, findCareerPage };
