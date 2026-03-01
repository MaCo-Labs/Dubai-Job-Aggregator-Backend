const axios = require('axios');
const logger = require('../config/logger');
const Company = require('../models/Company');

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * Use OpenAI (ChatGPT) to discover official website and LinkedIn URL for a company.
 */
const discoverWithAI = async (companyName, industry, tower) => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        logger.warn('No API_KEY found in .env — skipping AI discovery');
        return null;
    }

    const prompt = `I need the official website URL and LinkedIn company page URL for this company located in Dubai, UAE.

Company Name: "${companyName}"
Industry: "${industry || 'Unknown'}"
Location: ${tower ? `${tower}, Dubai, UAE` : 'Dubai, UAE'}

Rules:
- Return ONLY a JSON object with two keys: "websiteUrl" and "linkedinUrl"
- If you cannot find a reliable URL, set it to null
- For LinkedIn, use the format: https://www.linkedin.com/company/slug
- For website, use the main official website (not social media or directory pages)
- Do NOT make up URLs — only return URLs you are confident are correct
- Return raw JSON with no markdown formatting, no backticks

Example response:
{"websiteUrl": "https://www.example.com", "linkedinUrl": "https://www.linkedin.com/company/example"}`;

    try {
        const response = await axios.post(
            OPENAI_API_URL,
            {
                model: 'gpt-4o-mini',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a business research assistant. Return only raw JSON with no markdown formatting.',
                    },
                    { role: 'user', content: prompt },
                ],
                temperature: 0.1,
                max_tokens: 200,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiKey}`,
                },
                timeout: 30000,
            }
        );

        const content = response.data.choices?.[0]?.message?.content?.trim();
        if (!content) return null;

        // Clean up response — remove markdown code fences if present
        const cleaned = content
            .replace(/```json\s*/gi, '')
            .replace(/```\s*/g, '')
            .trim();

        const parsed = JSON.parse(cleaned);
        return {
            websiteUrl: parsed.websiteUrl || null,
            linkedinUrl: parsed.linkedinUrl || null,
        };
    } catch (error) {
        logger.warn(`AI discovery failed for "${companyName}": ${error.message}`);
        return null;
    }
};

/**
 * Try to guess the website URL by common domain patterns
 */
const guessWebsiteUrl = async (companyName) => {
    // Generate possible domain names
    const slug = companyName
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, '')
        .trim();

    const slugDash = companyName
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, '-')
        .trim();

    // Generate shorter variations (first word, first two words)
    const words = companyName.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/);
    const firstWord = words[0] || slug;
    const firstTwo = words.slice(0, 2).join('');
    const firstTwoDash = words.slice(0, 2).join('-');

    const candidates = [
        ...new Set([
            `https://www.${slug}.com`,
            `https://www.${slug}.ae`,
            `https://www.${slugDash}.com`,
            `https://www.${slugDash}.ae`,
            `https://${slug}.com`,
            `https://${slug}.ae`,
            `https://www.${firstWord}.com`,
            `https://www.${firstWord}.ae`,
            `https://www.${firstTwo}.com`,
            `https://www.${firstTwoDash}.com`,
        ]),
    ];

    const results = await Promise.all(candidates.map(async (url) => {
        try {
            const response = await axios.head(url, {
                timeout: 5000,
                maxRedirects: 5,
                validateStatus: (status) => status < 400,
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                },
            });
            if (response.status < 400) {
                return url;
            }
        } catch {
            return null;
        }
        return null;
    }));

    const found = results.find(r => r !== null);
    if (found) {
        logger.info(`URL guess hit: ${found}`);
        return found;
    }

    return null;
};

/**
 * Discover website and LinkedIn URLs for a single company
 */
const discoverCompanyUrls = async (company) => {
    logger.info(`🔍 Discovering URLs for: ${company.name}`);

    try {
        await Company.findByIdAndUpdate(company._id, { discoveryStatus: 'searching' });

        let websiteUrl = company.websiteUrl || null;
        let linkedinUrl = company.linkedinUrl || null;
        let method = null;

        // Skip if both URLs already exist
        if (websiteUrl && linkedinUrl) {
            logger.info(`${company.name}: URLs already present, skipping discovery`);
            await Company.findByIdAndUpdate(company._id, { discoveryStatus: 'skipped' });
            return { company: company.name, websiteUrl, linkedinUrl, status: 'skipped' };
        }

        // Strategy 1: AI Discovery (ChatGPT)
        const aiResult = await discoverWithAI(company.name, company.industry, company.tower);
        if (aiResult) {
            if (!websiteUrl && aiResult.websiteUrl) {
                websiteUrl = aiResult.websiteUrl;
                method = 'chatgpt';
            }
            if (!linkedinUrl && aiResult.linkedinUrl) {
                linkedinUrl = aiResult.linkedinUrl;
            }
        }

        // Strategy 2: URL Guessing (if still no website)
        if (!websiteUrl) {
            const guessed = await guessWebsiteUrl(company.name);
            if (guessed) {
                websiteUrl = guessed;
                method = method || 'url_guess';
            }
        }

        // Update the company record
        const updateData = {
            discoveryStatus: websiteUrl || linkedinUrl ? 'found' : 'not_found',
            discoveryMethod: method,
        };
        if (websiteUrl) updateData.websiteUrl = websiteUrl;
        if (linkedinUrl) updateData.linkedinUrl = linkedinUrl;

        await Company.findByIdAndUpdate(company._id, updateData);

        logger.info(
            `${company.name}: website=${websiteUrl || 'NOT FOUND'}, linkedin=${linkedinUrl || 'NOT FOUND'} (method: ${method || 'none'})`
        );

        return {
            company: company.name,
            websiteUrl,
            linkedinUrl,
            status: updateData.discoveryStatus,
            method,
        };
    } catch (error) {
        logger.error(`Discovery error for ${company.name}: ${error.message}`);
        await Company.findByIdAndUpdate(company._id, {
            discoveryStatus: 'not_found',
        });
        return { company: company.name, status: 'error', error: error.message };
    }
};

/**
 * Discover URLs for all companies that don't have them yet
 */
const discoverAllCompanies = async (query = null) => {
    const companies = await Company.find(query || {
        $or: [
            { websiteUrl: { $in: [null, ''] } },
            { linkedinUrl: { $in: [null, ''] } },
        ],
    });

    logger.info(`Starting parallel discovery for ${companies.length} companies`);
    const results = [];
    const CONCURRENCY = 10; // Increased concurrency for discovery

    for (let i = 0; i < companies.length; i += CONCURRENCY) {
        const batch = companies.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
            batch.map(async (company) => {
                try {
                    return await discoverCompanyUrls(company);
                } catch (err) {
                    logger.error(`Error in batch discovery for ${company.name}: ${err.message}`);
                    return { company: company.name, status: 'error', error: err.message };
                }
            })
        );
        results.push(...batchResults);
    }

    const found = results.filter((r) => r.status === 'found').length;
    const notFound = results.filter((r) => r.status === 'not_found').length;

    logger.info(`Discovery complete: ${found} found, ${notFound} not found, out of ${companies.length} total`);
    return results;
};

module.exports = { discoverCompanyUrls, discoverAllCompanies };
