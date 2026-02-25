const mongoose = require('mongoose');

const companySchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            index: true,
        },
        websiteUrl: {
            type: String,
            trim: true,
        },
        linkedinUrl: {
            type: String,
            trim: true,
        },
        industry: {
            type: String,
            trim: true,
            index: true,
        },
        tower: {
            type: String,
            trim: true,
            index: true,
        },
        careerPageUrl: {
            type: String,
            trim: true,
        },
        discoveryStatus: {
            type: String,
            enum: ['pending', 'searching', 'found', 'not_found', 'skipped'],
            default: 'pending',
            index: true,
        },
        discoveryMethod: {
            type: String,
            trim: true,
        },
        scrapeStatus: {
            type: String,
            enum: ['pending', 'scraping', 'completed', 'failed', 'no_jobs_found'],
            default: 'pending',
            index: true,
        },
        scrapeError: {
            type: String,
        },
        lastScrapedAt: {
            type: Date,
        },
        jobCount: {
            type: Number,
            default: 0,
        },
    },
    {
        timestamps: true,
    }
);

companySchema.index({ name: 1, tower: 1 }, { unique: true });

module.exports = mongoose.model('Company', companySchema);
