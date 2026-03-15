const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const http = require('http');
const os = require('os');
const socketIo = require('socket.io');
const nodemailer = require('nodemailer');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = 3000;

const FUZZERS_FILE = path.join(__dirname, 'fuzzers.json');
const LEXBOR_DIR = process.env.LEXBOR_DIR || path.join(__dirname, '..', 'lexbor');
const LEXBOR_REPO_URL = process.env.LEXBOR_REPO_URL || 'https://github.com/lexbor/lexbor.git';
const AMALGAMATION_CACHE_DIR = path.join(__dirname, '.amalgamation_cache');

const amalgamationLib = require('./lib/amalgamation');
amalgamationLib.init(LEXBOR_DIR, AMALGAMATION_CACHE_DIR, LEXBOR_REPO_URL);

if (!process.env.LEXBOR_SECRET
    || !process.env.LEXBOR_ADMIN
    || !process.env.LEXBOR_ADMIN_PASS)
{
    env_info();
    process.exit(1);
}

function env_info() {
    console.error('Please, set environment:');
    console.error('\tLEXBOR_SECRET');
    console.error('\tLEXBOR_ADMIN');
    console.error('\tLEXBOR_ADMIN_PASS');
}

// Email Transporter Configuration
// NOTE: Replace with real SMTP credentials in production
const transporter = nodemailer.createTransport({
    host: 'smtp.lexbor.com',
    port: 587,
    auth: {
        user: '',
        pass: ''
    }
});

// Helper to send email
const sendCrashNotification = async (email, fuzzerName, crashFile) => {
    if (!email) return;

    const mailOptions = {
        from: '"Fuzzer Admin" <postmaster@lexbor.com>',
        to: email,
        subject: `[CRASH ALERT] New crash detected for ${fuzzerName}`,
        text: `
            Fuzzer: ${fuzzerName}
            Time: ${new Date().toLocaleString()}
            Crash File: ${crashFile}
            
            Please check the admin panel for details.
        `
    };

    try {
        // In a real app, we would await this. For now, we just log it if it fails (likely due to bad creds)
        // or just log the attempt to console since we don't have real SMTP.
        console.log('---------------------------------------------------');
        console.log(`[MOCK EMAIL] To: ${email}`);
        console.log(`Subject: ${mailOptions.subject}`);
        console.log(mailOptions.text);
        console.log('---------------------------------------------------');
        
        // await transporter.sendMail(mailOptions); 
    } catch (error) {
        console.error('Error sending email:', error);
    }
};

// Helper to read fuzzers
const getFuzzers = () => {
    try {
        if (!fs.existsSync(FUZZERS_FILE)) return [];
        const data = fs.readFileSync(FUZZERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error('Error reading fuzzers file:', err);
        return [];
    }
};

// Helper to write fuzzers
const saveFuzzers = (fuzzers) => {
    try {
        fs.writeFileSync(FUZZERS_FILE, JSON.stringify(fuzzers, null, 2));
    } catch (err) {
        console.error('Error writing fuzzers file:', err);
    }
};

// Helper to check if process is running
const isProcessRunning = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
};

// Helper to format duration
const formatDuration = (startTime) => {
    if (!startTime) return '-';
    const diff = Date.now() - new Date(startTime).getTime();
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
};

// Helper to get process stats (CPU and Memory)
const getProcessStats = (pid) => {
    return new Promise((resolve) => {
        // pcpu: percentage of CPU usage
        // rss: resident set size (memory) in KB
        exec(`ps -p ${pid} -o pcpu=,rss=`, (error, stdout, stderr) => {
            if (error || stderr) {
                resolve({ cpu: '0.0', memory: '0.00 MB' });
                return;
            }
            
            const parts = stdout.trim().split(/\s+/);
            if (parts.length < 2) {
                resolve({ cpu: '0.0', memory: '0.00 MB' });
                return;
            }

            const cpu = parseFloat(parts[0]).toFixed(1);
            const rss = parseInt(parts[1], 10); // KB
            const memory = isNaN(rss) ? '0.00 MB' : (rss / 1024).toFixed(2) + ' MB';

            resolve({ cpu, memory });
        });
    });
};

// Helper to get crash count
const getCrashCount = (crashDir) => {
    try {
        if (fs.existsSync(crashDir)) {
            return fs.readdirSync(crashDir).length;
        }
    } catch (e) {
        console.error('Error counting crashes:', e);
    }
    return 0;
};

// Set EJS as the view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware to parse POST request bodies
app.use(express.urlencoded({ extended: true }));

// Session configuration
const sessionMiddleware = session({
    secret: process.env.LEXBOR_SECRET, // In production, use a secure random string
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
});

app.use(sessionMiddleware);

// Share session with Socket.IO
io.engine.use(sessionMiddleware);

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Amalgamation routes
app.use(require('./routes/amalgamation'));

// Authentication middleware
const requireAuth = (req, res, next) => {
    if (req.session.isAuthenticated) {
        next();
    } else {
        res.redirect('/login');
    }
};

// Login page route
app.get('/login', (req, res) => {
    if (req.session.isAuthenticated) {
        res.redirect('/');
    } else {
        res.render('login', { 
            title: 'Login',
            error: req.query.error ? 'Invalid credentials' : null,
            cb: req.query.cb ? req.query.cb : ""
        });
    }
});

// Login action
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const redirect = req.query.cb ? req.query.cb : "/"

    // Simple hardcoded credentials (in production, use a database)
    if (username === process.env.LEXBOR_ADMIN && password === process.env.LEXBOR_ADMIN_PASS) {
        req.session.isAuthenticated = true;
        req.session.user = username;
        res.redirect(redirect);
    } else {
        res.redirect('/login?cb=' + encodeURIComponent(redirect) + '&error=1');
    }
});

// Admin dashboard (protected)
app.get('/admin', requireAuth, (req, res) => {
    res.render('admin', { 
        title: 'Admin Dashboard',
        user: req.session.user || 'Administrator'
    });
});

// Developers Page
app.get('/developers', (req, res) => {
    res.render('developers');
});

// Fuzzers Management Routes
app.get('/fuzzers', (req, res) => {
    let fuzzers = getFuzzers();
    let updated = false;

    // Update status and duration
    fuzzers = fuzzers.map(f => {
        if (f.pid) {
            if (!isProcessRunning(f.pid)) {
                f.pid = null;
                f.startTime = null;
                f.duration = '-';
                updated = true;
            } else {
                f.duration = formatDuration(f.startTime);
            }
        }
        // Add crash count
        f.crashCount = getCrashCount(f.crashDir);
        return f;
    });

    if (updated) saveFuzzers(fuzzers);

    res.render('fuzzers', {
        fuzzers: fuzzers,
        is_admin: req.session.isAuthenticated,
        originalUrl: req.originalUrl
    });
});

app.post('/fuzzers/add', requireAuth, (req, res) => {
    const { name, path: fuzzerPath, dict, args: fuzzerARGS, email } = req.body;
    const fuzzers = getFuzzers();

    // Automatically determine crash directory
    // Format: /path/to/fuzzer_dir/fuzzer_name_crashes
    const fuzzerDir = path.dirname(fuzzerPath);
    const fuzzerName = path.basename(fuzzerPath);
    const crashDir = path.join(fuzzerDir, `${fuzzerName}_crashes`);
    const corpusDir = path.join(fuzzerDir, `${fuzzerName}_corpus`);

    // Ensure crash directory exists
    try {
        if (!fs.existsSync(crashDir)) {
            fs.mkdirSync(crashDir, { recursive: true });
        }
    } catch (err) {
        console.error('Error creating crash directory:', err);
    }

    // Ensure corpus directory exists
    try {
        if (!fs.existsSync(corpusDir)) {
            fs.mkdirSync(corpusDir, { recursive: true });
        }
    } catch (err) {
        console.error('Error creating corpus directory:', err);
    }

    fuzzers.push({
        id: Date.now().toString(),
        name,
        path: fuzzerPath,
        crashDir: crashDir,
        corpusDir: corpusDir,
        email: email || null,
        knownCrashes: [], // Track known crashes to avoid duplicate alerts
        pid: null,
        startTime: null,
        dict: dict.trim(),
        args: fuzzerARGS.trim()
    });

    saveFuzzers(fuzzers);
    res.redirect('/fuzzers');
});

app.post('/fuzzers/start/:id', requireAuth, (req, res) => {
    const fuzzers = getFuzzers();
    const fuzzer = fuzzers.find(f => f.id === req.params.id);

    if (fuzzer && !fuzzer.pid) {
        try {
            // Determine log directory and file
            // Format: /path/to/fuzzer_dir/fuzzer_name_logs/fuzzer.log
            const fuzzerDir = path.dirname(fuzzer.path);
            const crashDir = fuzzer.crashDir;
            let corpusDir = fuzzer.corpusDir;
            const fuzzerName = path.basename(fuzzer.path);
            const logDir = path.join(fuzzerDir, `${fuzzerName}_logs`);
            const logPath = path.join(logDir, 'fuzzer.log');
            let args = [`-artifact_prefix=${crashDir}/`];

            if (fuzzer.dict?.length > 0) {
                args.push(`-dict=${fuzzer.dict}`);
            }

            if (fuzzer.args?.length > 0) {
                const parts = fuzzer.args.trim().split(/\s+/);
                args.push(...parts);
            }

            // Ensure crash directory exists
            if (!fs.existsSync(crashDir)) {
                fs.mkdirSync(crashDir, { recursive: true });
            }

            // Ensure log directory exists
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

            // Ensure corpus directory exists
            if (!corpusDir) {
                corpusDir = path.join(fuzzerDir, `${fuzzerName}_corpus`);
            }

            if (!fs.existsSync(corpusDir)) {
                fs.mkdirSync(corpusDir, { recursive: true });
            }
            args.push(corpusDir);

            const out = fs.openSync(logPath, 'a');
            const err = fs.openSync(logPath, 'a');

            // Spawn the process detached so it keeps running
            const child = spawn(fuzzer.path, args, {
                detached: true,
                stdio: ['ignore', out, err]
            });

            child.unref();

            fuzzer.pid = child.pid;
            fuzzer.startTime = new Date().toISOString();
            fuzzer.logPath = logPath; // Save log path for reference
            fuzzer.corpusDir = corpusDir;
            saveFuzzers(fuzzers);
        } catch (err) {
            console.error('Failed to start fuzzer:', err);
        }
    }

    res.redirect('/fuzzers');
});

app.post('/fuzzers/stop/:id', requireAuth, (req, res) => {
    const fuzzers = getFuzzers();
    const fuzzer = fuzzers.find(f => f.id === req.params.id);
    
    if (fuzzer && fuzzer.pid) {
        try {
            process.kill(fuzzer.pid);
            fuzzer.pid = null;
            fuzzer.startTime = null;
            saveFuzzers(fuzzers);
        } catch (err) {
            console.error('Failed to stop fuzzer:', err);
        }
    }
    
    res.redirect('/fuzzers');
});

app.post('/fuzzers/delete/:id', requireAuth, (req, res) => {
    let fuzzers = getFuzzers();
    const fuzzer = fuzzers.find(f => f.id === req.params.id);
    
    // Stop if running before deleting
    if (fuzzer && fuzzer.pid) {
        try {
            process.kill(fuzzer.pid);
        } catch (e) {}
    }
    
    fuzzers = fuzzers.filter(f => f.id !== req.params.id);
    saveFuzzers(fuzzers);
    res.redirect('/fuzzers');
});

app.post('/fuzzers/start-all', requireAuth, (req, res) => {
    const fuzzers = getFuzzers();

    for (const fuzzer of fuzzers) {
        if (fuzzer.pid) continue;

        try {
            const fuzzerDir = path.dirname(fuzzer.path);
            const crashDir = fuzzer.crashDir;
            let corpusDir = fuzzer.corpusDir;
            const fuzzerName = path.basename(fuzzer.path);
            const logDir = path.join(fuzzerDir, `${fuzzerName}_logs`);
            const logPath = path.join(logDir, 'fuzzer.log');
            let args = [`-artifact_prefix=${crashDir}/`];

            if (fuzzer.dict?.length > 0) {
                args.push(`-dict=${fuzzer.dict}`);
            }

            if (fuzzer.args?.length > 0) {
                const parts = fuzzer.args.trim().split(/\s+/);
                args.push(...parts);
            }

            if (!fs.existsSync(crashDir)) fs.mkdirSync(crashDir, { recursive: true });
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

            if (!corpusDir) {
                corpusDir = path.join(fuzzerDir, `${fuzzerName}_corpus`);
            }
            if (!fs.existsSync(corpusDir)) fs.mkdirSync(corpusDir, { recursive: true });
            args.push(corpusDir);

            const out = fs.openSync(logPath, 'a');
            const err = fs.openSync(logPath, 'a');

            const child = spawn(fuzzer.path, args, {
                detached: true,
                stdio: ['ignore', out, err]
            });

            child.unref();

            fuzzer.pid = child.pid;
            fuzzer.startTime = new Date().toISOString();
            fuzzer.logPath = logPath;
            fuzzer.corpusDir = corpusDir;
        } catch (err) {
            console.error(`Failed to start fuzzer ${fuzzer.name}:`, err);
        }
    }

    saveFuzzers(fuzzers);
    res.redirect('/fuzzers');
});

app.post('/fuzzers/stop-all', requireAuth, (req, res) => {
    const fuzzers = getFuzzers();

    for (const fuzzer of fuzzers) {
        if (!fuzzer.pid) continue;

        try {
            process.kill(fuzzer.pid);
        } catch (e) {}

        fuzzer.pid = null;
        fuzzer.startTime = null;
    }

    saveFuzzers(fuzzers);
    res.redirect('/fuzzers');
});

// View Logs Route
app.get('/fuzzers/logs/:id', (req, res) => {
    const fuzzers = getFuzzers();
    const fuzzer = fuzzers.find(f => f.id === req.params.id);
    
    if (!fuzzer) {
        return res.redirect('/fuzzers');
    }

    res.render('logs', {
        title: `Logs: ${fuzzer.name}`,
        fuzzer: fuzzer
    });
});

// View Crashes Route
app.get('/fuzzers/crashes/:id', (req, res) => {
    const fuzzers = getFuzzers();
    const fuzzer = fuzzers.find(f => f.id === req.params.id);
    
    if (!fuzzer || !fuzzer.crashDir) {
        return res.redirect('/fuzzers');
    }

    let crashes = [];
    try {
        if (fs.existsSync(fuzzer.crashDir)) {
            const files = fs.readdirSync(fuzzer.crashDir);
            crashes = files.map(file => {
                const filePath = path.join(fuzzer.crashDir, file);
                const stats = fs.statSync(filePath);
                return {
                    name: file,
                    size: (stats.size / 1024).toFixed(2) + ' KB',
                    date: stats.mtime.toLocaleString()
                };
            });
        }
    } catch (err) {
        console.error('Error reading crash directory:', err);
    }

    res.render('crashes', {
        title: `Crashes: ${fuzzer.name}`,
        fuzzer: fuzzer,
        crashes: crashes
    });
});

// Download Crash Route
app.get('/fuzzers/crashes/:id/download/:filename', requireAuth, (req, res) => {
    const fuzzers = getFuzzers();
    const fuzzer = fuzzers.find(f => f.id === req.params.id);
    
    if (!fuzzer || !fuzzer.crashDir) {
        return res.status(404).send('Fuzzer or crash directory not found');
    }

    const filePath = path.join(fuzzer.crashDir, req.params.filename);
    
    // Security check: prevent directory traversal
    if (!filePath.startsWith(path.resolve(fuzzer.crashDir))) {
        return res.status(403).send('Access denied');
    }

    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).send('File not found');
    }
});

// Delete Crash Route
app.post('/fuzzers/crashes/:id/delete/:filename', requireAuth, (req, res) => {
    const fuzzers = getFuzzers();
    const fuzzer = fuzzers.find(f => f.id === req.params.id);
    
    if (!fuzzer || !fuzzer.crashDir) {
        return res.status(404).send('Fuzzer or crash directory not found');
    }

    const filePath = path.join(fuzzer.crashDir, req.params.filename);
    
    // Security check: prevent directory traversal
    if (!filePath.startsWith(path.resolve(fuzzer.crashDir))) {
        return res.status(403).send('Access denied');
    }

    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (err) {
        console.error('Error deleting crash file:', err);
    }

    res.redirect(`/fuzzers/crashes/${fuzzer.id}`);
});

// Socket.io connection for logs
io.on('connection', (socket) => {
    // Check authentication
    const session = socket.request.session;
    if (session && session.isAuthenticated) {
        socket.join('admins');
    }

    socket.on('join_log', (fuzzerId) => {
        // Ensure user is authenticated for logs too
        // if (!socket.request.session || !socket.request.session.isAuthenticated) {
        //     return;
        // }

        const fuzzers = getFuzzers();
        const fuzzer = fuzzers.find(f => f.id === fuzzerId);
        
        if (!fuzzer || !fuzzer.logPath) {
            socket.emit('log_data', 'Log path not configured or fuzzer not found.\n');
            return;
        }

        const logPath = fuzzer.logPath;

        // Start from the end of the file (tail)
        let currentSize = 0;
        try {
            const stats = fs.statSync(logPath);
            currentSize = stats.size;
        } catch (e) {}

        // Send a message indicating we are starting from now
        socket.emit('log_data', `[Connected to log stream. Showing new logs from ${new Date().toLocaleTimeString()}...]\n`);

        if (fs.existsSync(logPath)) {
            const watcher = fs.watch(logPath, (eventType) => {
                if (eventType === 'change') {
                    fs.stat(logPath, (err, stats) => {
                        if (err) return;
                        
                        if (stats.size > currentSize) {
                            const stream = fs.createReadStream(logPath, {
                                start: currentSize,
                                end: stats.size
                            });
                            
                            stream.on('data', (chunk) => {
                                socket.emit('log_data', chunk.toString());
                            });
                            
                            currentSize = stats.size;
                        } else if (stats.size < currentSize) {
                            // File was truncated
                            currentSize = stats.size;
                            socket.emit('log_data', '\n[Logs cleared]\n');
                        }
                    });
                }
            });

            socket.on('disconnect', () => {
                watcher.close();
            });
        } else {
            socket.emit('log_data', 'No logs found for this fuzzer yet.\n');
        }
    });
});

// Log cleanup task (every 10 minutes)
setInterval(() => {
    console.log('Running log cleanup...');
    const fuzzers = getFuzzers();
    fuzzers.forEach(fuzzer => {
        if (fuzzer.pid && fuzzer.logPath && fs.existsSync(fuzzer.logPath)) {
            try {
                fs.truncateSync(fuzzer.logPath, 0);
                console.log(`Cleared logs for fuzzer: ${fuzzer.name}`);
            } catch (err) {
                console.error(`Failed to clear logs for ${fuzzer.name}:`, err);
            }
        }
    });
}, 10 * 60 * 1000); // 10 minutes

// Fetch lexbor updates (every 5 minutes)
setInterval(() => {
    amalgamationLib.fetchUpdates();
}, 5 * 60 * 1000);

// Cleanup stale master cache (every hour)
setInterval(() => {
    amalgamationLib.cleanupMasterCache();
}, 60 * 60 * 1000);

// Broadcast fuzzer stats (every 2 seconds)
setInterval(async () => {
    const fuzzers = getFuzzers();
    const fuzzerStats = {};
    let updated = false;

    // System Stats
    const systemStats = {
        cores: os.cpus().length,
        load: os.loadavg()[0].toFixed(2), // 1 minute load average
        memory: os.totalmem(),
        memory_free: os.freemem()
    };

    for (const fuzzer of fuzzers) {
        // Check for new crashes
        let currentCrashes = [];
        try {
            if (fs.existsSync(fuzzer.crashDir)) {
                currentCrashes = fs.readdirSync(fuzzer.crashDir);
            }
        } catch (e) {}

        const crashCount = currentCrashes.length;

        // Initialize knownCrashes if missing (migration)
        if (!fuzzer.knownCrashes) {
            fuzzer.knownCrashes = currentCrashes;
            updated = true;
        }

        // Detect new crashes
        const newCrashes = currentCrashes.filter(c => !fuzzer.knownCrashes.includes(c));
        
        if (newCrashes.length > 0) {
            // Send notifications
            for (const crash of newCrashes) {
                console.log(`New crash detected for ${fuzzer.name}: ${crash}`);
                if (fuzzer.email) {
                    sendCrashNotification(fuzzer.email, fuzzer.name, crash);
                }
            }
            
            // Update known crashes
            fuzzer.knownCrashes = [...fuzzer.knownCrashes, ...newCrashes];
            updated = true;
        }

        if (fuzzer.pid) {
            if (isProcessRunning(fuzzer.pid)) {
                const procStats = await getProcessStats(fuzzer.pid);
                fuzzerStats[fuzzer.id] = {
                    isRunning: true,
                    pid: fuzzer.pid,
                    duration: formatDuration(fuzzer.startTime),
                    cpu: procStats.cpu + '%',
                    memory: procStats.memory,
                    crashCount: crashCount
                };
            } else {
                // Process died unexpectedly
                fuzzer.pid = null;
                fuzzer.startTime = null;
                updated = true;
                fuzzerStats[fuzzer.id] = {
                    isRunning: false,
                    duration: '-',
                    cpu: '-',
                    memory: '-',
                    crashCount: crashCount
                };
            }
        } else {
            fuzzerStats[fuzzer.id] = {
                isRunning: false,
                duration: '-',
                cpu: '-',
                memory: '-',
                crashCount: crashCount
            };
        }
    }

    if (updated) saveFuzzers(fuzzers);

    // Prepare stats for public (without crashCount)
    const publicFuzzerStats = {};
    const sensitiveFuzzerStats = {};

    for (const [id, stat] of Object.entries(fuzzerStats)) {
        const { crashCount, pid, isRunning, ...rest } = stat;
        publicFuzzerStats[id] = rest;
        sensitiveFuzzerStats[id] = { crashCount, pid, isRunning };
    }

    const publicStats = { system: systemStats, fuzzers: publicFuzzerStats };
    const sensitiveStats = { fuzzers: sensitiveFuzzerStats };

    // Emit public stats to everyone
    io.emit('fuzzer_stats', publicStats);

    // Emit sensitive stats (crashCount) only to admins
    io.to('admins').emit('fuzzer_sensitive_stats', sensitiveStats);
}, 2000);

// Logout action
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
        }
        res.redirect(req.query.cb ? req.query.cb : "/");
    });
});

server.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
