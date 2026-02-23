const http = require('http');

const HOST = process.env.TEST_HOST || '192.168.178.51';
const PORT = process.env.TEST_PORT || 8091;
const PIN = process.env.ADMIN_PIN || 'test-pin';
const PIN_HEADER = { 'x-admin-pin': PIN };

// Request Helper
function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: HOST,
            port: PORT,
            path: path,
            method: method,
            headers: {
                ...headers,
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let parsed;
                try {
                    parsed = data ? JSON.parse(data) : {};
                } catch (e) {
                    parsed = data;
                }
                resolve({ status: res.statusCode, body: parsed });
            });
        });

        req.on('error', (e) => reject(e));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// Test Suite
async function runTests() {
    console.log(`\n🔍 STARTING SYSTEM CHECK - ${new Date().toISOString()}\n`);
    let errors = 0;

    async function test(name, fn) {
        try {
            process.stdout.write(`Testing: ${name}... `);
            await fn();
            console.log('✅ OK');
        } catch (e) {
            console.log(`❌ FAIL\n  Error: ${e.message}`);
            errors++;
        }
    }

    // --- NAMES ---
    await test('Names API - Initially Empty (or List)', async () => {
        const res = await request('GET', '/api/names');
        if (res.status !== 200 || !Array.isArray(res.body)) throw new Error('Failed to get names list');
    });

    let testNameId;
    await test('Names API - Add Name', async () => {
        const res = await request('POST', '/api/names', { name: "TestBaby" });
        if (res.status !== 201) throw new Error(`Status ${res.status}`);
        if (res.body.name !== "TestBaby") throw new Error('Name mismatch');
        testNameId = res.body.id;
    });

    await test('Names API - Vote for Name (Up)', async () => {
        const res = await request('POST', '/api/vote', { id: testNameId, type: 'up' });
        if (res.status !== 200) throw new Error(`Status ${res.status}`);
        if (res.body.votes !== 1) throw new Error('Vote count mismatch');
    });

    await test('Names API - Vote for Name (Down)', async () => {
        const headers = { 'x-forwarded-for': '203.0.113.1' };
        const res = await request('POST', '/api/vote', { id: testNameId, type: 'down' }, headers);
        if (res.status !== 200) throw new Error(`Status ${res.status}`);
        if (res.body.votes !== 1) throw new Error('Vote count changed unexpectedly');
        if (res.body.dislikes !== 1) throw new Error('Dislike count mismatch');
    });

    await test('Names API - Delete Name (No PIN)', async () => {
        const res = await request('DELETE', `/api/names/${testNameId}`);
        if (res.status !== 401) throw new Error(`Should return 401, got ${res.status}`);
    });

    await test('Names API - Delete Name (With PIN)', async () => {
        const res = await request('DELETE', `/api/names/${testNameId}`, null, PIN_HEADER);
        if (res.status !== 200) throw new Error(`Status ${res.status}`);
    });


    // --- WISHLIST ---
    let wishId;
    await test('Wishlist API - Add Item (With PIN)', async () => {
        const item = { name: "TestItem", link: "http://test.com", price: "10€" };
        const res = await request('POST', '/api/wishlist', item, PIN_HEADER);
        if (res.status !== 201) throw new Error(`Status ${res.status}`);
        wishId = res.body.id;
    });

    await test('Wishlist API - Reserve Item', async () => {
        const res = await request('POST', '/api/wishlist/reserve', { id: wishId, reservedBy: "Tester" });
        if (res.status !== 200) throw new Error(`Status ${res.status}`);
        if (!res.body.reserved) throw new Error('Not reserved');
    });

    await test('Wishlist API - Delete Item (With PIN)', async () => {
        const res = await request('DELETE', `/api/wishlist/${wishId}`, null, PIN_HEADER);
        if (res.status !== 200) throw new Error(`Status ${res.status}`);
    });


    // --- BETS ---
    let betId;
    await test('Bets API - Add Bet', async () => {
        const bet = { name: "TestBet", date: "2026-08-20", time: "12:00", weight: 3500, size: 50 };
        const res = await request('POST', '/api/bets', bet);
        if (res.status !== 201) throw new Error(`Status ${res.status}`);
        betId = res.body.id;
    });

    await test('Bets API - Delete Bet (With PIN)', async () => {
        const res = await request('DELETE', `/api/bets/${betId}`, null, PIN_HEADER);
        if (res.status !== 200) throw new Error(`Status ${res.status}`);
    });


    // --- FLOhMARKT (OFFERS) ---
    let offerId;
    await test('Offers API - Add Offer', async () => {
        const offer = {
            name: "TestUser",
            email: "test@example.com",
            description: "Babybett",
            imageBase64: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" // Valid 1x1 PNG for sharp to parse
        };
        const res = await request('POST', '/api/offers', offer);
        if (res.status !== 201) throw new Error(`Status ${res.status}`);
        offerId = res.body.id;
    });

    await test('Offers API - Get Offers (Public API hides email)', async () => {
        const res = await request('GET', '/api/offers');
        if (res.status !== 200) throw new Error(`Status ${res.status}`);
        const found = res.body.find(o => o.id === offerId);
        if (!found) throw new Error('Offer not found in public list');
        if (found.email) throw new Error('Email was not stripped from public response');
    });

    await test('Offers API - Get Offers (Admin API shows email)', async () => {
        const res = await request('GET', '/api/offers', null, PIN_HEADER);
        if (res.status !== 200) throw new Error(`Status ${res.status}`);
        const found = res.body.find(o => o.id === offerId);
        if (!found) throw new Error('Offer not found in admin list');
        if (found.email !== "test@example.com") throw new Error('Email missing or mismatched in admin response');
    });

    await test('Offers API - Delete Offer (With PIN)', async () => {
        const res = await request('DELETE', `/api/offers/${offerId}`, null, PIN_HEADER);
        if (res.status !== 200) throw new Error(`Status ${res.status}`);
    });


    console.log(`\n🏁 SUMMARY: ${errors === 0 ? 'ALL TESTS PASSED' : errors + ' ERRORS FOUND'}`);
    if (errors > 0) process.exit(1);
}

runTests();
