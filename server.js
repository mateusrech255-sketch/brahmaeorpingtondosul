const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;

const MIME_TYPES = {
    '.html': 'text/html; charset=UTF-8',
    '.js': 'text/javascript; charset=UTF-8',
    '.css': 'text/css; charset=UTF-8',
    '.json': 'application/json; charset=UTF-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf'
};

const server = http.createServer((req, res) => {
    let reqUrl = req.url.split('?')[0].split('#')[0];
    if (reqUrl === '/' || reqUrl === '') {
        reqUrl = '/index.html';
    }

    let safePath = path.normalize(reqUrl).replace(/^(\.\.[\/\\])+/, '');
    let filePath = path.join(PUBLIC_DIR, safePath);

    const serveFile = (targetPath) => {
        const ext = path.extname(targetPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        const stream = fs.createReadStream(targetPath);
        stream.pipe(res);
    };

    fs.stat(filePath, (err, stats) => {
        if (!err && stats.isFile()) {
            return serveFile(filePath);
        }

        // Suporte a URLs amigáveis (ex: /politica-de-privacidade -> /politica-de-privacidade.html)
        const htmlPath = filePath + '.html';
        fs.stat(htmlPath, (htmlErr, htmlStats) => {
            if (!htmlErr && htmlStats.isFile()) {
                return serveFile(htmlPath);
            }

            const fallbackPath = path.join(PUBLIC_DIR, 'index.html');
            fs.readFile(fallbackPath, (fallbackErr, data) => {
                if (fallbackErr) {
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
                    res.end('404 Not Found');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
                res.end(data);
            });
        });
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Servidor local iniciado com sucesso!`);
    console.log(`📡 URL Local:   http://localhost:${PORT}`);
    console.log(`📂 Diretório:   ${PUBLIC_DIR}`);
    console.log(`Pressione Ctrl+C para encerrar o servidor.\n`);
});
