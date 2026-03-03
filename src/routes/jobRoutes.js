const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const controller = require('../controllers/jobController');

// Multer setup for XLSX uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, '../../uploads'));
    },
    filename: (req, file, cb) => {
        cb(null, `companies_${Date.now()}${path.extname(file.originalname)}`);
    },
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const allowedExt = ['.xlsx', '.xls'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExt.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error('Only .xlsx and .xls files are allowed'));
        }
    },
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Routes
router.post('/upload', upload.single('file'), controller.uploadCompanies);

// Discovery routes (find website/LinkedIn URLs)
router.post('/discover', controller.discoverAll);
router.post('/discover/:companyId', controller.discoverOne);

// Scraping routes
router.post('/scrape', controller.scrapeAll);
router.post('/scrape/:companyId', controller.scrapeOne);
router.post('/scrape-ai', controller.scrapeWithAI);

// Data routes
router.get('/jobs', controller.getJobs);
router.get('/jobs/:id', controller.getJob);
router.get('/companies', controller.getCompanies);
router.get('/towers', controller.getTowers);
router.get('/stats', controller.getStats);

// Admin
router.delete('/reset', controller.resetData);

module.exports = router;
