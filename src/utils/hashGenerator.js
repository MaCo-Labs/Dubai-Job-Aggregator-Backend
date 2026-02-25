const crypto = require('crypto');

const generateHash = (title, companyName, location = '') => {
    const normalized = `${title}|${companyName}|${location}`
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
    return crypto.createHash('sha256').update(normalized).digest('hex');
};

module.exports = { generateHash };
