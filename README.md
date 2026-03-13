## Node.js backend for lexbor

Backend for [lexbor.com](https://lexbor.com):

- **Fuzzers Manager** — web UI for managing fuzz testing processes: start/stop fuzzers, monitor logs, track crashes. See https://lexbor.com/fuzzers/
- **Amalgamation Generator** — public API and web UI for building single-file lexbor distributions from selected modules and versions. See https://lexbor.com/generate/amalgamation

## Environment

Required:

| Variable | Description |
|---|---|
| `LEXBOR_SECRET` | Session secret key |
| `LEXBOR_ADMIN` | Admin username |
| `LEXBOR_ADMIN_PASS` | Admin password |

Optional:

| Variable | Default | Description |
|---|---|---|
| `LEXBOR_DIR` | `../lexbor` | Path to the lexbor repository clone |
| `LEXBOR_REPO_URL` | `https://github.com/lexbor/lexbor.git` | Git repo URL; used to auto-clone if `LEXBOR_DIR` doesn't exist |

## Dependencies

- Node.js
- Perl (for `single.pl` amalgamation generator)
- Git (lexbor repo clone at `LEXBOR_DIR`)

## Amalgamation API

Public API for generating lexbor amalgamation files (single-file builds).

### GET /generate/amalgamation

`https://lexbor.com/generate/amalgamation`

HTML page with a form for selecting version, modules, filename, and extension.

### GET /api/amalgamation/modules

`https://lexbor.com/api/amalgamation/modules?version=latest`

Returns available modules for a given version.

**Parameters:**

| Parameter | Required | Description |
|---|---|---|
| `version` | yes | `latest`, `master`, or a tag (e.g. `v2.7.0`) |

**Response:**

```json
{
  "modules": ["core", "css", "dom", "encoding", ...],
  "version": "v2.7.0"
}
```

### GET /api/amalgamation

`https://lexbor.com/api/amalgamation?version=latest&modules=core,dom&ext=h`

Generates and downloads an amalgamation file.

**Parameters:**

| Parameter | Required | Default | Description |
|---|---|---|---|
| `version` | yes | | `latest`, `master`, or a tag (e.g. `v2.7.0`) |
| `modules` | yes | | Comma-separated module names (e.g. `core,dom,html`) |
| `ext` | no | `h` | File extension: `h` or `c` |
| `filename` | no | auto | Custom filename (alphanumeric, `_`, `-`) |

**Filename rules:**

- All modules selected: `lexbor-<version>.<ext>`
- Custom filename: `<filename>-<version>.<ext>`
- Subset of modules: `<module1>_<module2>-<version>.<ext>`
- For master, version includes commit hash: `master_a1b2c3`

**Examples:**

```bash
# Latest release, all modules
curl -OJ "https://lexbor.com/api/amalgamation?version=latest&modules=core,css,dom,encoding,engine,html,ns,punycode,selectors,style,tag,unicode,url,utils"

# Specific version, selected modules
curl -OJ "https://lexbor.com/api/amalgamation?version=v2.7.0&modules=core,dom,html&ext=h"

# Custom filename
curl -OJ "https://lexbor.com/api/amalgamation?version=latest&modules=core,dom&filename=my_lexbor&ext=c"

# Master branch
curl -OJ "https://lexbor.com/api/amalgamation?version=master&modules=core"
```

**Errors:**

| Code | Description |
|---|---|
| 400 | Missing parameters, unknown version, invalid module for the version, bad extension |
| 500 | Generation failure |

Results are cached. Tag versions are cached permanently. Master is cached by commit hash (6 chars).

## Deployment

### 1. Install dependencies

```bash
sudo apt update
sudo apt install -y nginx git curl perl nodejs npm
```

### 2. Clone and setup

```bash
git clone https://github.com/lexbor/fuzzers-manager lexbor-backend
cd lexbor-backend
npm install
```

The lexbor repository will be auto-cloned on first start from `LEXBOR_REPO_URL` if it doesn't exist at `LEXBOR_DIR`.

### 3. Configure environment

Create `/var/www/lexbor-backend/.env` or set variables in PM2 ecosystem file:

```bash
export LEXBOR_SECRET="your-secret-key"
export LEXBOR_ADMIN="admin"
export LEXBOR_ADMIN_PASS="your-password"
export LEXBOR_DIR="/var/www/lexbor"
export LEXBOR_REPO_URL="https://github.com/lexbor/lexbor.git"
```

### 4. Start with PM2

```bash
sudo npm install -g pm2

LEXBOR_SECRET="your-secret-key" \
LEXBOR_ADMIN="admin" \
LEXBOR_ADMIN_PASS="your-password" \
LEXBOR_DIR="/var/www/lexbor" \
pm2 start server.js --name "lexbor-backend"
pm2 startup
pm2 save
```

Or use an ecosystem file `ecosystem.config.js`:

```javascript
module.exports = {
    apps: [{
        name: 'lexbor-backend',
        script: 'server.js',
        env: {
            LEXBOR_SECRET: 'your-secret-key',
            LEXBOR_ADMIN: 'admin',
            LEXBOR_ADMIN_PASS: 'your-password',
            LEXBOR_DIR: '/var/www/lexbor',
            LEXBOR_REPO_URL: 'https://github.com/lexbor/lexbor.git'
        }
    }]
};
```

```bash
pm2 start ecosystem.config.js
pm2 save
```

### 5. Configure Nginx

Add to your nginx server block:

```nginx
location ~ ^/(socket.io|admin|fuzzers|login|logout|generate|api) {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_cache_bypass $http_upgrade;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;
}
```

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 6. Verify

```bash
# HTML page
curl -s https://lexbor.com/generate/amalgamation | head -5

# API: list modules
curl -s https://lexbor.com/api/amalgamation/modules?version=latest

# API: download file
curl -OJ "https://lexbor.com/api/amalgamation?version=latest&modules=core,dom&ext=h"
```

### Maintenance

- **Logs**: `pm2 logs lexbor-backend`
- **Restart**: `pm2 restart lexbor-backend`
- **Update**: `git pull && npm install && pm2 restart lexbor-backend`
- **Cache**: lexbor repo is auto-updated every 5 minutes (`git fetch --tags`). Amalgamation results are cached in `.amalgamation_cache/`.

## COPYRIGHT AND LICENSE

   Lexbor.

   Copyright 2018-2026 Alexander Borisov
