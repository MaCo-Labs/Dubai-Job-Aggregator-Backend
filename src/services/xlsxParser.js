const XLSX = require('xlsx');
const path = require('path');
const logger = require('../config/logger');

/**
 * Parse an XLSX file — reads ALL sheets.
 * Each sheet name is treated as a "tower" (building location).
 *
 * Supports two column layouts:
 *   Layout A (original): "Company Name", "Official Website URL", "LinkedIn URL", "Industry"
 *   Layout B (tower):    First col = company name, second col = industry (no URLs)
 */
const parseXLSX = (filePath) => {
    try {
        const workbook = XLSX.readFile(filePath);
        const allCompanies = [];

        for (const sheetName of workbook.SheetNames) {
            const sheet = workbook.Sheets[sheetName];
            const rawData = XLSX.utils.sheet_to_json(sheet, { defval: '' });

            if (!rawData.length) {
                logger.warn(`Sheet "${sheetName}" is empty, skipping`);
                continue;
            }

            const fileHeaders = Object.keys(rawData[0]);

            // Detect column layout
            const headerMap = detectHeaders(fileHeaders);

            if (!headerMap.name) {
                // Fallback: assume first column is name, second is industry
                const firstCol = fileHeaders[0];
                const secondCol = fileHeaders.length > 1 ? fileHeaders[1] : null;

                logger.info(`Sheet "${sheetName}": Using fallback mapping — col "${firstCol}" as name, col "${secondCol || 'none'}" as industry`);

                for (const row of rawData) {
                    const name = String(row[firstCol] || '').trim();
                    if (!name) continue;

                    const company = {
                        name,
                        industry: secondCol ? String(row[secondCol] || '').trim() : '',
                        websiteUrl: '',
                        linkedinUrl: '',
                        tower: sheetName.trim(),
                    };

                    allCompanies.push(company);
                }
            } else {
                // Standard header mapping
                for (const row of rawData) {
                    const company = {
                        name: '',
                        websiteUrl: '',
                        linkedinUrl: '',
                        industry: '',
                        tower: sheetName.trim(),
                    };

                    for (const [header, fieldName] of Object.entries(headerMap)) {
                        company[fieldName] = String(row[header] || '').trim();
                    }

                    if (!company.name) continue;

                    // Normalize URLs
                    if (company.websiteUrl && !company.websiteUrl.startsWith('http')) {
                        company.websiteUrl = 'https://' + company.websiteUrl;
                    }
                    if (company.linkedinUrl && !company.linkedinUrl.startsWith('http')) {
                        company.linkedinUrl = 'https://' + company.linkedinUrl;
                    }

                    allCompanies.push(company);
                }
            }

            logger.info(`Sheet "${sheetName}": Parsed ${rawData.length} rows`);
        }

        logger.info(`Total: Parsed ${allCompanies.length} companies from ${workbook.SheetNames.length} sheets`);
        return allCompanies;
    } catch (error) {
        logger.error(`XLSX parse error: ${error.message}`);
        throw error;
    }
};

/**
 * Try to match file headers to our expected schema fields
 */
function detectHeaders(fileHeaders) {
    const EXPECTED_HEADERS = {
        'company name': 'name',
        'company': 'name',
        'name': 'name',
        'official website url': 'websiteUrl',
        'website url': 'websiteUrl',
        'website': 'websiteUrl',
        'linkedin url': 'linkedinUrl',
        'linkedin': 'linkedinUrl',
        'industry': 'industry',
        'sector': 'industry',
        'category': 'industry',
    };

    const headerMap = {};

    for (const header of fileHeaders) {
        const normalised = header.trim().toLowerCase();
        if (EXPECTED_HEADERS[normalised]) {
            headerMap[header] = EXPECTED_HEADERS[normalised];
        }
    }

    return headerMap;
}

module.exports = { parseXLSX };
