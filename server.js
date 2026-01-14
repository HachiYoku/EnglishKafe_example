const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true
}));
app.use(express.static('public'));
app.use('/images', express.static('images'));
app.use('/uploads', express.static('uploads'));

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Database setup
const db = new sqlite3.Database('./restaurant.db');

// Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS content (
    id INTEGER PRIMARY KEY,
    section TEXT,
    key TEXT,
    value TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS menu (
    id INTEGER PRIMARY KEY,
    name TEXT,
    description TEXT,
    price REAL,
    image TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS chefs (
    id INTEGER PRIMARY KEY,
    name TEXT,
    role TEXT,
    image TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY,
    title TEXT,
    youtube_link TEXT,
    embed_id TEXT
  )`);

  // Ensure 'description' column exists on videos table (for older DBs)
  db.all("PRAGMA table_info(videos)", (err, cols) => {
    if (err) return console.error(err);
    const hasDescription = cols.some(c => c.name === 'description');
    if (!hasDescription) {
      db.run("ALTER TABLE videos ADD COLUMN description TEXT", (err) => {
        if (err) console.error('Failed to add description column to videos:', err);
      });
    }
    // Add 'host' column to indicate 'youtube' or 'cloud'
    const hasHost = cols.some(c => c.name === 'host');
    if (!hasHost) {
      db.run("ALTER TABLE videos ADD COLUMN host TEXT DEFAULT 'youtube'", (err) => {
        if (err) console.error('Failed to add host column to videos:', err);
      });
    }

    // Add 'cloud_link' column for cloud-hosted video URLs
    const hasCloudLink = cols.some(c => c.name === 'cloud_link');
    if (!hasCloudLink) {
      db.run("ALTER TABLE videos ADD COLUMN cloud_link TEXT", (err) => {
        if (err) console.error('Failed to add cloud_link column to videos:', err);
      });
    }
  });

  // Insert default content if not exists
  db.get("SELECT COUNT(*) as count FROM content", (err, row) => {
    if (row.count === 0) {
      insertDefaultContent();
    }
  });
});

// File upload setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// Routes
app.get('/', (req, res) => {
  db.all("SELECT * FROM content", (err, rows) => {
    const content = {};
    rows.forEach(row => {
      if (!content[row.section]) content[row.section] = {};
      content[row.section][row.key] = row.value;
    });

    db.all("SELECT * FROM menu", (err, menu) => {
      db.all("SELECT * FROM chefs", (err, chefs) => {
        db.all("SELECT * FROM videos", (err, videos) => {
          // separate youtube-hosted and cloud-hosted videos for rendering
          const youtubeVideos = videos.filter(v => !v.host || v.host === 'youtube');
          const cloudVideos = videos.filter(v => v.host === 'cloud');
          res.render('index', { content, menu, chefs, videos: youtubeVideos, cloudVideos });
        });
      });
    });
  });
});

app.get('/admin', (req, res) => {
  if (req.session.loggedIn) {
    db.all("SELECT * FROM content", (err, rows) => {
      const content = {};
      rows.forEach(row => {
        if (!content[row.section]) content[row.section] = {};
        content[row.section][row.key] = row.value;
      });

      db.all("SELECT * FROM menu", (err, menu) => {
        db.all("SELECT * FROM chefs", (err, chefs) => {
          db.all("SELECT * FROM videos", (err, videos) => {
            // for admin, provide both lists
            const youtubeVideos = videos.filter(v => !v.host || v.host === 'youtube');
            const cloudVideos = videos.filter(v => v.host === 'cloud');
            // pass any warning message from query string
            const warning = req.query && req.query.warning ? req.query.warning : null;
            res.render('admin', { content, menu, chefs, videos: youtubeVideos, cloudVideos, warning });
          });
        });
      });
    });
  } else {
    res.redirect('/login');
  }
});

// Helper: perform HEAD request and follow redirects (up to maxRedirects)
function checkHead(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    try {
      const visited = 0;
      const doHead = (currentUrl, redirectsLeft) => {
        const parsed = new URL(currentUrl);
        const lib = parsed.protocol === 'https:' ? https : http;
        const options = {
          method: 'HEAD',
          headers: {
            'User-Agent': 'EnglishKafe-HealthCheck/1.0'
          }
        };
        const req = lib.request(currentUrl, options, (res) => {
          // follow redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
            const next = new URL(res.headers.location, currentUrl).toString();
            doHead(next, redirectsLeft - 1);
            return;
          }
          resolve({ statusCode: res.statusCode, headers: res.headers, url: currentUrl });
        });
        req.on('error', (err) => reject(err));
        req.end();
      };
      doHead(url, maxRedirects);
    } catch (err) {
      reject(err);
    }
  });
}

app.get('/login', (req, res) => {
  res.render('login');
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'password') {
    req.session.loggedIn = true;
    res.redirect('/admin');
  } else {
    res.render('login', { error: 'Invalid credentials' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Update content
app.post('/admin/content', (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');

  const { section, key, value } = req.body;

  // Support single key/value or multiple (when forms include multiple inputs with same name)
  const isKeyArray = Array.isArray(key);
  const isValueArray = Array.isArray(value);

  if (isKeyArray || isValueArray) {
    // Normalize to arrays of equal length
    const keys = isKeyArray ? key : [key];
    const values = isValueArray ? value : [value];

    const len = Math.max(keys.length, values.length);
    const stmt = db.prepare("INSERT OR REPLACE INTO content (section, key, value) VALUES (?, ?, ?)");
    for (let i = 0; i < len; i++) {
      const k = keys[i];
      const v = values[i];
      // Skip empty keys
      if (!k) continue;
      stmt.run(section, k, v, (err) => { if (err) console.error(err); });
    }
    stmt.finalize(() => res.redirect('/admin'));
  } else {
    db.run("INSERT OR REPLACE INTO content (section, key, value) VALUES (?, ?, ?)", [section, key, value], (err) => {
      if (err) console.error(err);
      res.redirect('/admin');
    });
  }
});

// Upload image and update content
app.post('/admin/upload', upload.single('image'), (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');

  const { section, key } = req.body;
  const imagePath = req.file ? `/uploads/${req.file.filename}` : null;

  if (imagePath) {
    db.run("INSERT OR REPLACE INTO content (section, key, value) VALUES (?, ?, ?)", [section, key, imagePath], (err) => {
      if (err) console.error(err);
      res.redirect('/admin');
    });
  } else {
    res.redirect('/admin');
  }
});

// Add menu item
app.post('/admin/menu', upload.single('image'), (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');

  const { name, description, price } = req.body;
  const image = req.file ? `/uploads/${req.file.filename}` : '';

  db.run("INSERT INTO menu (name, description, price, image) VALUES (?, ?, ?, ?)", [name, description, price, image], (err) => {
    if (err) console.error(err);
    res.redirect('/admin');
  });
});

// Add instructor (stored in chefs table)
app.post('/admin/chef', upload.single('image'), (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');

  // Admin form now submits 'description' for instructors.
  const { name, description } = req.body;
  const image = req.file ? `/uploads/${req.file.filename}` : '';

  // Keep DB column 'role' for backward compatibility; store description there.
  db.run("INSERT INTO chefs (name, role, image) VALUES (?, ?, ?)", [name, description, image], (err) => {
    if (err) console.error(err);
    res.redirect('/admin');
  });
});

// Delete menu item
app.post('/admin/menu/delete/:id', (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');

  const id = req.params.id;
  db.run("DELETE FROM menu WHERE id = ?", [id], (err) => {
    if (err) console.error(err);
    res.redirect('/admin');
  });
});

// Update menu item
app.post('/admin/menu/update/:id', upload.single('image'), (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');

  const id = req.params.id;
  const { name, description, price } = req.body;
  const imagePath = req.file ? `/uploads/${req.file.filename}` : null;

  if (imagePath) {
    db.run("UPDATE menu SET name = ?, description = ?, price = ?, image = ? WHERE id = ?", [name, description, price, imagePath, id], (err) => {
      if (err) console.error(err);
      res.redirect('/admin');
    });
  } else {
    db.run("UPDATE menu SET name = ?, description = ?, price = ? WHERE id = ?", [name, description, price, id], (err) => {
      if (err) console.error(err);
      res.redirect('/admin');
    });
  }
});

// Delete chef
app.post('/admin/chef/delete/:id', (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');

  const id = req.params.id;
  db.run("DELETE FROM chefs WHERE id = ?", [id], (err) => {
    if (err) console.error(err);
    res.redirect('/admin');
  });
});

// Add video
app.post('/admin/video', (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');

  const { title, description } = req.body;
  const host = req.body.host || 'youtube';

  if (host === 'youtube') {
    const youtube_link = req.body.youtube_link || '';
    // Extract video ID from YouTube link
    const videoIdMatch = youtube_link.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/]+\/.+\/(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
    const embed_id = videoIdMatch ? videoIdMatch[1] : null;

    if (embed_id) {
      db.run("INSERT INTO videos (title, youtube_link, embed_id, description, host) VALUES (?, ?, ?, ?, ?)", [title, youtube_link, embed_id, description || '', 'youtube'], (err) => {
        if (err) console.error(err);
        res.redirect('/admin');
      });
    } else {
      // invalid youtube link
      res.redirect('/admin');
    }
  } else if (host === 'cloud') {
    const cloud_link = req.body.cloud_link || '';
    if (!cloud_link) return res.redirect('/admin');
    // Perform HEAD-check on the cloud link to warn about content-type or range support
    checkHead(cloud_link).then(({ statusCode, headers }) => {
      const warnings = [];
      const contentType = headers['content-type'] || '';
      const acceptRanges = headers['accept-ranges'] || headers['Accept-Ranges'] || '';
      if (!contentType.startsWith('video/')) {
        warnings.push(`Content-Type is '${contentType || 'unknown'}' (not a recognized video type)`);
      }
      if (!(acceptRanges && acceptRanges.toLowerCase().includes('bytes'))) {
        warnings.push("Server doesn't advertise 'Accept-Ranges: bytes' — seeking may not work properly.");
      }

      db.run("INSERT INTO videos (title, description, host, cloud_link) VALUES (?, ?, ?, ?)", [title, description || '', 'cloud', cloud_link], (err) => {
        if (err) console.error(err);
        let redirectUrl = '/admin';
        if (warnings.length) {
          redirectUrl += '?warning=' + encodeURIComponent(warnings.join(' '));
        }
        res.redirect(redirectUrl);
      });
    }).catch((err) => {
      // HEAD failed; still insert but warn admin
      const warning = `HEAD request failed: ${err.message}`;
      db.run("INSERT INTO videos (title, description, host, cloud_link) VALUES (?, ?, ?, ?)", [title, description || '', 'cloud', cloud_link], (dbErr) => {
        if (dbErr) console.error(dbErr);
        res.redirect('/admin?warning=' + encodeURIComponent(warning));
      });
    });
  } else {
    res.redirect('/admin');
  }
});

// Delete video
app.post('/admin/video/delete/:id', (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');

  const id = req.params.id;
  db.run("DELETE FROM videos WHERE id = ?", [id], (err) => {
    if (err) console.error(err);
    res.redirect('/admin');
  });
});

// Update video
app.post('/admin/video/update/:id', (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');

  const id = req.params.id;
  const host = req.body.host || 'youtube';
  const title = req.body.title || '';
  const description = req.body.description || '';

  if (host === 'youtube') {
    const youtube_link = req.body.youtube_link || '';
    const videoIdMatch = youtube_link.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/]+\/.+\/(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
    const embed_id = videoIdMatch ? videoIdMatch[1] : null;

    if (embed_id) {
      db.run("UPDATE videos SET title = ?, youtube_link = ?, embed_id = ?, description = ?, host = ?, cloud_link = NULL WHERE id = ?", [title, youtube_link, embed_id, description, 'youtube', id], (err) => {
        if (err) console.error(err);
        res.redirect('/admin');
      });
    } else {
      // update without changing embed_id
      db.run("UPDATE videos SET title = ?, youtube_link = ?, description = ?, host = ? WHERE id = ?", [title, youtube_link, description, 'youtube', id], (err) => {
        if (err) console.error(err);
        res.redirect('/admin');
      });
    }
  } else if (host === 'cloud') {
    const cloud_link = req.body.cloud_link || '';
    db.run("UPDATE videos SET title = ?, description = ?, host = ?, cloud_link = ?, youtube_link = NULL, embed_id = NULL WHERE id = ?", [title, description, 'cloud', cloud_link, id], (err) => {
      if (err) console.error(err);
      res.redirect('/admin');
    });
  } else {
    res.redirect('/admin');
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Endpoint: POST /admin/check-url
// Expects JSON { url: 'https://...' }
app.post('/admin/check-url', (req, res) => {
  if (!req.session.loggedIn) return res.status(401).json({ error: 'Unauthorized' });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing url' });

  checkHead(url).then(({ statusCode, headers }) => {
    const warnings = [];
    const contentType = headers['content-type'] || '';
    const acceptRanges = headers['accept-ranges'] || headers['Accept-Ranges'] || '';
    if (!contentType.startsWith('video/')) {
      warnings.push(`Content-Type is '${contentType || 'unknown'}' (not a recognized video type)`);
    }
    if (!(acceptRanges && acceptRanges.toLowerCase().includes('bytes'))) {
      warnings.push("Server doesn't advertise 'Accept-Ranges: bytes' — seeking may not work properly.");
    }
    res.json({ statusCode, headers, warnings });
  }).catch((err) => {
    res.status(500).json({ error: err.message });
  });
});

// Default content insertion
function insertDefaultContent() {
  const defaultContent = [
    // Home slides
    ['home', 'slide1_title', 'Learn English with EnglishKafe'],
    ['home', 'slide1_text', 'Practical lessons, conversation practice, and progress tracking for all levels.'],
    ['home', 'slide2_title', 'Speak Confidently'],
    ['home', 'slide2_text', 'Live classes and speaking clubs to improve your fluency.'],
    ['home', 'slide3_title', 'Prepare for Exams'],
    ['home', 'slide3_text', 'Expert tutors and tailored courses for IELTS, TOEFL, and more.'],

    // About
    ['about', 'title', 'About EnglishKafe'],
    ['about', 'text1', 'EnglishKafe offers structured courses and live practice sessions to help learners gain confidence and real-world English skills. Our instructors focus on communication, grammar, and exam readiness.'],
    ['about', 'text2', 'We blend interactive lessons, video content, and community practice to make learning effective and enjoyable. Join learners worldwide and start improving today.'],

    // Services -> Courses / Offerings
    ['services', 'beginner_title', 'Beginner Course'],
    ['services', 'beginner_text', 'Foundations of English: vocabulary, basic grammar, simple conversations.'],
    ['services', 'intermediate_title', 'Intermediate Course'],
    ['services', 'intermediate_text', 'Build fluency with guided speaking practice and expanded grammar.'],
    ['services', 'conversation_title', 'Conversation Club'],
    ['services', 'conversation_text', 'Weekly speaking sessions to practice real-life topics with peers.'],
    ['services', 'examprep_title', 'Exam Preparation'],
    ['services', 'examprep_text', 'Targeted coaching for IELTS, TOEFL and other standardized tests.']
  ];

  defaultContent.forEach(([section, key, value]) => {
    db.run("INSERT INTO content (section, key, value) VALUES (?, ?, ?)", [section, key, value]);
  });
}