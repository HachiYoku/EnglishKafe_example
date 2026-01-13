const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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
          res.render('index', { content, menu, chefs, videos });
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
            res.render('admin', { content, menu, chefs, videos });
          });
        });
      });
    });
  } else {
    res.redirect('/login');
  }
});

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
  db.run("INSERT OR REPLACE INTO content (section, key, value) VALUES (?, ?, ?)", [section, key, value], (err) => {
    if (err) console.error(err);
    res.redirect('/admin');
  });
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

// Add chef
app.post('/admin/chef', upload.single('image'), (req, res) => {
  if (!req.session.loggedIn) return res.redirect('/login');

  const { name, role } = req.body;
  const image = req.file ? `/uploads/${req.file.filename}` : '';

  db.run("INSERT INTO chefs (name, role, image) VALUES (?, ?, ?)", [name, role, image], (err) => {
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

  const { title, youtube_link } = req.body;
  // Extract video ID from YouTube link
  const videoIdMatch = youtube_link.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
  const embed_id = videoIdMatch ? videoIdMatch[1] : null;

  if (embed_id) {
    db.run("INSERT INTO videos (title, youtube_link, embed_id) VALUES (?, ?, ?)", [title, youtube_link, embed_id], (err) => {
      if (err) console.error(err);
      res.redirect('/admin');
    });
  } else {
    res.redirect('/admin'); // Invalid link
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Default content insertion
function insertDefaultContent() {
  const defaultContent = [
    ['home', 'slide1_title', 'Welcome to Brio Restaurant'],
    ['home', 'slide1_text', 'Some representative placeholder content for the first slide.'],
    ['home', 'slide2_title', 'The real taste of food'],
    ['home', 'slide2_text', 'Some representative placeholder content for the second slide.'],
    ['home', 'slide3_title', 'Only taste is real for food'],
    ['home', 'slide3_text', 'Some representative placeholder content for the third slide.'],
    ['about', 'title', 'About Brio Restaurant'],
    ['about', 'text1', 'Lorem ipsum dolor sit amet, consectetur adipisicing elit. Excepturi perferendis magnam ea necessitatibus, officiis voluptas odit! Aperiam omnis, cupiditate laudantium velit nostrum, exercitationem accusamus, possimus soluta illo.Lorem ipsum dolor sit amet, consectetur adipisicing elit. Excepturi perferendis magnam ea necessitatibus, officiis voluptas odit.'],
    ['about', 'text2', 'Lorem ipsum dolor sit amet, consectetur adipisicing elit. Excepturi perferendis magnam ea necessitatibus, officiis voluptas odit! Aperiam omnis, cupiditate laudantium velit nostrum.'],
    ['services', 'home_delivery_title', 'Home Delivery'],
    ['services', 'home_delivery_text', 'Lorem ipsum dolor sit amet, consectetur adipisicing elit. Excepturi perferendis magnam ea necessitatibus, officiis voluptas odit! Aperiam omnis, cupiditate laudantium velit nostrum.'],
    ['services', 'birthday_party_title', 'Birthday Party'],
    ['services', 'birthday_party_text', 'Lorem ipsum dolor sit amet, consectetur adipisicing elit. Excepturi perferendis magnam ea necessitatibus, officiis voluptas odit! Aperiam omnis, cupiditate laudantium velit nostrum.'],
    ['services', 'wedding_party_title', 'Wedding Party'],
    ['services', 'wedding_party_text', 'Lorem ipsum dolor sit amet, consectetur adipisicing elit. Excepturi perferendis magnam ea necessitatibus, officiis voluptas odit! Aperiam omnis, cupiditate laudantium velit nostrum.'],
    ['services', 'event_party_title', 'Event Party'],
    ['services', 'event_party_text', 'Lorem ipsum dolor sit amet, consectetur adipisicing elit. Excepturi perferendis magnam ea necessitatibus, officiis voluptas odit! Aperiam omnis, cupiditate laudantium velit nostrum.']
  ];

  defaultContent.forEach(([section, key, value]) => {
    db.run("INSERT INTO content (section, key, value) VALUES (?, ?, ?)", [section, key, value]);
  });
}