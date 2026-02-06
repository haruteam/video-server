import express from 'express';
import { Readable } from 'stream';
import { Innertube, Platform } from 'youtubei.js/web';

const app = express();
const PORT = 3000;

Platform.shim.eval = async (data, env) => {
    const props = [];
    const q = (v) => JSON.stringify(String(v));

    if (env && env.n) {
        props.push(`n: exportedVars.nFunction(${q(env.n)})`);
    }
    if (env && env.sig) {
        props.push(`sig: exportedVars.sigFunction(${q(env.sig)})`);
    }

    const code = `${data.output}\nreturn { ${props.join(', ')} }`;
    return new Function(code)();
};

let yt;

(async () => {
    yt = await Innertube.create({
        user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36'
    });
})();

function extractVideoId(input) {
    const m = String(input || '').match(/(?:v=|\.be\/)([\w-]{11})/);
    return m ? m[1] : null;
}

function toNodeReadable(maybeWebStream) {
    if (!maybeWebStream) return null;
    if (typeof maybeWebStream.pipe === 'function') return maybeWebStream;
    if (typeof Readable.fromWeb === 'function' && typeof maybeWebStream.getReader === 'function') {
        return Readable.fromWeb(maybeWebStream);
    }
    return null;
}

function sendJson(res, status, obj) {
    res.status(status);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(obj));
}

function pickRrUrlFromError(err) {
    const u = err?.info?.response?.url || err?.response?.url || err?.url;
    if (u && typeof u === 'string' && u.includes('googlevideo.com')) return u;
    return null;
}

function getTitleAndDuration(info) {
    const b = info?.basic_info;
    const title = b?.title ?? null;
    const duration = b?.duration ?? null;
    return { title, duration };
}

app.get('/play', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        sendJson(res, 400, { error: 'Missing url parameter' });
        return;
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
        sendJson(res, 400, { error: 'Invalid YouTube URL' });
        return;
    }

    try {
        if (!yt) {
            sendJson(res, 503, { error: 'Innertube not ready' });
            return;
        }

        const info = await yt.getInfo(String(videoId));
        const meta = getTitleAndDuration(info);

        try {
            const webStream = await info.download({
                type: 'video+audio',
                quality: 'best',
                format: 'mp4'
            });

            const nodeStream = toNodeReadable(webStream);
            if (nodeStream) {
                sendJson(res, 200, { videoId, title: meta.title, duration: meta.duration, url: null });
                try { nodeStream.destroy(); } catch (e) {}
                return;
            }

            sendJson(res, 500, { videoId, title: meta.title, duration: meta.duration, url: null, error: 'Unsupported stream type' });
            return;

        } catch (err) {
            const rrUrl = pickRrUrlFromError(err);
            if (!rrUrl) {
                sendJson(res, 500, { videoId, title: meta.title, duration: meta.duration, url: null, error: 'Failed to retrieve stream URL' });
                return;
            }
            sendJson(res, 200, { videoId, title: meta.title, duration: meta.duration, url: rrUrl });
            return;
        }

    } catch (err) {
        const rrUrl = pickRrUrlFromError(err);
        if (!rrUrl) {
            sendJson(res, 500, { videoId, title: null, duration: null, url: null, error: 'Failed to retrieve video info and stream URL' });
            return;
        }
        sendJson(res, 200, { videoId, title: null, duration: null, url: rrUrl });
    }
});


app.listen(PORT, () => {
});