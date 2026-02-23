const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const sharp = require('sharp');

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'names.json');
const WISHLIST_FILE = path.join(DATA_DIR, 'wishlist.json');
const OFFERS_FILE = path.join(DATA_DIR, 'offers.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const ADMIN_PIN = process.env.ADMIN_PIN || '2026';

// Security: Trust proxy (Cloudflare) so req.ip is correct
app.set('trust proxy', 1);

// --- CONFIG ENDPOINT ---
app.get('/api/config', (req, res) => {
    res.json({
        appTitle: process.env.APP_TITLE || '👶 Baby-Dashboard',
        dueDate: process.env.DUE_DATE || '2026-08-20T00:00:00'
    });
});

// We apply different JSON limits per route to prevent DoS via massive payloads.
// The default is a strict 100kb limit, but /api/offers allows 10MB because of base64 image uploads.
app.use('/api/offers', express.json({ limit: '10mb' }));
app.use(express.json({ limit: '100kb' }));
app.use(cors());

// Security: Basic Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
    message: { error: 'Too many requests from this IP.' }
});
app.use('/api', limiter); // Apply to all API routes

// Security: Simple XSS Sanitizer for strings
const sanitize = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
};

// Serve static files
app.use(express.static('public', {
    setHeaders: (res, path, stat) => {
        if (path.endsWith('index.html')) {
            res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.set('Pragma', 'no-cache');
            res.set('Expires', '0');
        }
    }
}));
app.use('/uploads', express.static(UPLOADS_DIR));

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure names.json exists
if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
}

// Ensure wishlist.json exists
if (!fs.existsSync(WISHLIST_FILE)) {
    fs.writeFileSync(WISHLIST_FILE, JSON.stringify([], null, 2));
}

// Ensure offers files exist
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(OFFERS_FILE)) {
    fs.writeFileSync(OFFERS_FILE, JSON.stringify([], null, 2));
}

// Helper to read data
const readData = () => {
    try {
        const data = fs.readFileSync(DATA_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        return [];
    }
};

// Helper to write data
const writeData = (data) => {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
};

// Helper for wishlist
const readWishlist = () => {
    try {
        const data = fs.readFileSync(WISHLIST_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        return [];
    }
};

const writeWishlist = (data) => {
    fs.writeFileSync(WISHLIST_FILE, JSON.stringify(data, null, 2));
};

// GET /api/verify-pin
// Simple endpoint to let frontend verify PIN without hardcoding it
app.get('/api/verify-pin', (req, res) => {
    const pin = req.headers['x-admin-pin'];
    if (pin === ADMIN_PIN) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
});

// --- Names Endpoints ---

// GET /api/names
app.get('/api/names', (req, res) => {
    res.json(readData());
});

// POST /api/names (Add Suggestion)
app.post('/api/names', (req, res) => {
    let { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    if (name.length > 50) return res.status(400).json({ error: 'Name too long (max 50 chars)' });
    name = sanitize(name);

    const names = readData();
    // Start with 0 votes and 0 dislikes
    const newName = { id: Date.now().toString(), name, votes: 0, dislikes: 0, votedIPs: [] };
    names.push(newName);
    writeData(names);
    res.status(201).json(newName);
});

// DELETE /api/names/:id (Admin only)
app.delete('/api/names/:id', (req, res) => {
    const pin = req.headers['x-admin-pin'];
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorized' });

    let names = readData();
    names = names.filter(n => n.id !== req.params.id);
    writeData(names);
    res.json({ success: true });
});

// POST /api/vote (Vote for a name - Up or Down)
app.post('/api/vote', (req, res) => {
    const { id, type } = req.body;
    if (!id || !['up', 'down', 'none'].includes(type)) return res.status(400).json({ error: 'Invalid ID or type' });

    // Trust proxy is set globally. Use Express `req.ip` rather than trusting CF headers manually.
    // This stops attackers bypassing the limits when connecting directly instead of via Cloudflare.
    const clientIP = req.ip || 'unknown';

    const names = readData();
    const name = names.find(n => n.id === id);
    if (!name) return res.status(404).json({ error: 'Name not found' });

    // Backward compatibility: Convert legacy Array to Object if needed
    if (Array.isArray(name.votedIPs)) {
        const legacyMap = {};
        name.votedIPs.forEach(ip => {
            // We don't know if legacy was up or down, assume 'up' as it was the default intended action for most
            legacyMap[ip] = 'up';
        });
        name.votedIPs = legacyMap;
    } else if (!name.votedIPs) {
        name.votedIPs = {};
    }

    const previousVote = name.votedIPs[clientIP];

    // If IP is known, adjust totals by removing the old vote
    if (clientIP !== 'unknown' && previousVote) {
        if (previousVote === 'up') name.votes = Math.max(0, (name.votes || 0) - 1);
        if (previousVote === 'down') name.dislikes = Math.max(0, (name.dislikes || 0) - 1);
    }

    // Apply the new vote
    if (type === 'none') {
        // User withdrew their vote
        delete name.votedIPs[clientIP];
    } else {
        if (type === 'up') name.votes = (name.votes || 0) + 1;
        if (type === 'down') name.dislikes = (name.dislikes || 0) + 1;
        name.votedIPs[clientIP] = type;
    }

    writeData(names);
    res.json(name);
});

// --- Wishlist Endpoints ---

// GET /api/wishlist
app.get('/api/wishlist', (req, res) => {
    res.json(readWishlist());
});

// POST /api/wishlist - Add Item (Protected)
app.post('/api/wishlist', (req, res) => {
    const pin = req.headers['x-admin-pin'];
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorized' });

    let { name, link, price, note } = req.body;
    if (!name || !link) return res.status(400).json({ error: 'Name and Link required' });

    if (name.length > 200) return res.status(400).json({ error: 'Name too long (max 200 chars)' });
    if (price && price.length > 50) return res.status(400).json({ error: 'Price too long (max 50 chars)' });
    if (note && note.length > 500) return res.status(400).json({ error: 'Note too long (max 500 chars)' });

    try {
        const parsedUrl = new URL(link);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return res.status(400).json({ error: 'Invalid link protocol. Only http and https are allowed.' });
        }
    } catch (e) {
        return res.status(400).json({ error: 'Invalid link format.' });
    }

    name = sanitize(name);
    link = sanitize(link);
    price = sanitize(price);
    note = sanitize(note);

    const list = readWishlist();
    const newItem = {
        id: Date.now().toString(),
        name,
        link,
        price: price || '',
        note: note || '',
        reserved: false,
        reservedBy: null, // Could be used later
        date: new Date().toISOString()
    };

    list.push(newItem);
    writeWishlist(list);
    res.status(201).json(newItem);
});

// POST /api/wishlist/reserve - Toggle Reservation
app.post('/api/wishlist/reserve', (req, res) => {
    let { id, reservedBy } = req.body;
    if (!id) return res.status(400).json({ error: 'ID required' });
    reservedBy = sanitize(reservedBy);

    const list = readWishlist();
    const item = list.find(i => i.id === id);

    if (item) {
        item.reserved = !item.reserved;
        item.reservedBy = item.reserved ? (reservedBy || 'Anonymous') : null;
        writeWishlist(list);
        res.json(item);
    } else {
        res.status(404).json({ error: 'Not found' });
    }
});

// DELETE /api/wishlist/:id - Remove Item (Protected)
app.delete('/api/wishlist/:id', (req, res) => {
    const pin = req.headers['x-admin-pin'];
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorized' });

    let list = readWishlist();
    const initialLength = list.length;
    list = list.filter(i => i.id !== req.params.id);

    if (list.length === initialLength) return res.status(404).json({ error: 'Not found' });

    writeWishlist(list);
    res.json({ success: true });
});

// --- Betting Game Endpoints ---
const BETS_FILE = path.join(DATA_DIR, 'bets.json');

// Ensure bets.json exists
if (!fs.existsSync(BETS_FILE)) {
    fs.writeFileSync(BETS_FILE, JSON.stringify([], null, 2));
}

function readBets() {
    try {
        const data = fs.readFileSync(BETS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('Error reading bets:', err);
        return [];
    }
}

const writeBets = (data) => {
    fs.writeFileSync(BETS_FILE, JSON.stringify(data, null, 2));
};

// GET /api/bets
app.get('/api/bets', (req, res) => {
    res.json(readBets());
});

// POST /api/bets
app.post('/api/bets', (req, res) => {
    let { name, date, time, weight, size } = req.body;
    if (!name || !date || !weight || !size) return res.status(400).json({ error: 'Missing fields' });

    if (name.length > 50) return res.status(400).json({ error: 'Name too long (max 50 chars)' });

    name = sanitize(name);
    date = sanitize(date);
    time = sanitize(time);

    const list = readBets();
    const newBet = {
        id: Date.now().toString(),
        name,
        date,
        time: time || '12:00',
        weight: parseInt(weight),
        size: parseInt(size),
        timestamp: new Date().toISOString()
    };

    list.push(newBet);
    writeBets(list);
    res.status(201).json(newBet);
});

// DELETE /api/bets/:id (Admin only)
app.delete('/api/bets/:id', (req, res) => {
    const pin = req.headers['x-admin-pin'];
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorized' });

    let list = readBets();
    const initialLength = list.length;
    console.log(`[DELETE] Request ID: ${req.params.id}, Current Count: ${list.length}`);
    list = list.filter(b => b.id !== req.params.id);
    console.log(`[DELETE] New Count: ${list.length}`);

    if (list.length === initialLength) {
        console.log(`[DELETE] ID not found in list: ${JSON.stringify(list.map(b => b.id))}`);
        return res.status(404).json({ error: 'Not found' });
    }

    writeBets(list);
    res.json({ success: true });
});

// --- OFFERS (FLOHMARKT) Endpoints ---
function readOffers() {
    try {
        const data = fs.readFileSync(OFFERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('Error reading offers:', err);
        return [];
    }
}

const writeOffers = (data) => {
    fs.writeFileSync(OFFERS_FILE, JSON.stringify(data, null, 2));
};

// GET /api/offers
app.get('/api/offers', (req, res) => {
    const pin = req.headers['x-admin-pin'];
    const offers = readOffers();
    if (pin === ADMIN_PIN) {
        res.json(offers);
    } else {
        // Strip emails for public access to prevent bot scraping
        const publicOffers = offers.map(o => ({ ...o, email: undefined }));
        res.json(publicOffers);
    }
});

// POST /api/offers (Requires name, email, description, and base64 image)
app.post('/api/offers', async (req, res) => {
    let { name, email, description, imageBase64 } = req.body;
    if (!name || !description || !imageBase64) return res.status(400).json({ error: 'Missing fields' });

    if (name.length > 50) return res.status(400).json({ error: 'Name too long (max 50 chars)' });
    if (description.length > 1000) return res.status(400).json({ error: 'Description too long (max 1000 chars)' });

    name = sanitize(name);
    email = sanitize(email);
    description = sanitize(description);

    const id = Date.now().toString();
    const matches = imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    let filename = '';

    if (matches && matches.length === 3) {
        const ext = 'jpg';
        filename = `${id}.${ext}`;
        const buffer = Buffer.from(matches[2], 'base64');

        try {
            await sharp(buffer)
                .resize({ width: 800, withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toFile(path.join(UPLOADS_DIR, filename));
        } catch (err) {
            console.error('Image processing failed:', err);
            return res.status(400).json({ error: 'Invalid image data' });
        }
    } else {
        return res.status(400).json({ error: 'Invalid image format' });
    }

    const list = readOffers();
    const newOffer = {
        id,
        name,
        email,
        description,
        imageUrl: `/uploads/${filename}`,
        timestamp: new Date().toISOString()
    };

    list.push(newOffer);
    writeOffers(list);
    res.status(201).json(newOffer);
});

// DELETE /api/offers/:id
app.delete('/api/offers/:id', (req, res) => {
    const pin = req.headers['x-admin-pin'];
    if (pin !== ADMIN_PIN) return res.status(401).json({ error: 'Unauthorized' });

    let list = readOffers();
    const item = list.find(o => o.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });

    // Try to delete the image file
    try {
        const filePath = path.join(DATA_DIR, 'uploads', item.imageUrl.replace('/uploads/', ''));
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (err) {
        console.error('Error deleting image:', err);
    }

    list = list.filter(o => o.id !== req.params.id);
    writeOffers(list);
    res.json({ success: true });
});

// --- Server Start ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});
