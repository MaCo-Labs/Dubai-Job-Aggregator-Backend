const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: true,
            trim: true,
            index: true,
        },
        company: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Company',
            required: true,
            index: true,
        },
        companyName: {
            type: String,
            trim: true,
            index: true,
        },
        location: {
            type: String,
            trim: true,
            default: 'Dubai, UAE',
        },
        description: {
            type: String,
            trim: true,
        },
        applyUrl: {
            type: String,
            trim: true,
        },
        source: {
            type: String,
            enum: ['website', 'linkedin'],
            default: 'website',
        },
        employmentType: {
            type: String,
            trim: true,
        },
        jobRole: {
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
        dedupeHash: {
            type: String,
            unique: true,
            index: true,
        },
        isActive: {
            type: Boolean,
            default: true,
            index: true,
        },
    },
    {
        timestamps: true,
    }
);

jobSchema.index({ title: 'text', companyName: 'text', description: 'text' });
jobSchema.index({ industry: 1, isActive: 1 });
jobSchema.index({ companyName: 1, isActive: 1 });

module.exports = mongoose.model('Job', jobSchema);
