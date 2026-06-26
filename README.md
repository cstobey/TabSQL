# Tab Outliner+

Tab Outliner clone with SQLite/MariaDB backend, native messaging host, and SQL management console.

## Structure

```
taboutliner/
  daemon/
    host.py          # native messaging host + HTTP server
    config.json      # backend config (edit before running)
    db/
      base.py        # abstract backend
      sqlite.py
      mariadb.py
      factory.py
  extension/
    manifest.json
    background.js
    sidebar/
      index.html
      tree.js
  sql/
    schema_sqlite.sql
    schema_mariadb.sql
  scripts/
    com.taboutliner.host.json   # Chrome native messaging manifest
    host_wrapper.bat            # launched by Chrome on Windows
    install_host.ps1            # one-shot Windows install script
  migrate.py
  management_ui.html            # open in browser, talks to HTTP endpoint
```

## Setup (Windows 11)

### 1. Migrate your data

```cmd
cd C:\taboutliner
python migrate.py --tree path\to\tree-exported-Wed-Jun-17-2026.tree
```

For MariaDB, edit `daemon/config.json` first:
```json
{ "backend": "mariadb", "mariadb": { "user": "...", "password": "..." } }
```
Then: `pip install pymysql`

### 2. Load the extension

- Open `chrome://extensions`
- Enable **Developer mode**
- **Load unpacked** → select `taboutliner/extension/`
- Note the **Extension ID** (32-char string)

### 3. Install native messaging host

```powershell
# Run in PowerShell (no admin needed)
cd C:\taboutliner\scripts
.\install_host.ps1 -ExtensionId "YOUR_EXTENSION_ID_HERE" -InstallDir "C:\taboutliner"
```

This writes the registry key Chrome looks for at:
`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.taboutliner.host`

Edit `host_wrapper.bat` if your Python path differs from `C:\Python312\python.exe`.

### 4. Verify

Restart Chrome. Click the Tab Outliner+ icon — the sidebar should open and load your tree.

The daemon also serves a management HTTP API on `http://127.0.0.1:7779`.
Open `management_ui.html` in a browser for the SQL console.

## Backend switching

Edit `daemon/config.json`:
```json
{ "backend": "sqlite" }    ← default, zero-config
{ "backend": "mariadb" }   ← Docker MariaDB
```

No code changes. Both backends implement the same interface.

## Ad-hoc querying (ksh/Python)

SQLite:
```sh
sqlite3 ~/taboutliner.db "SELECT * FROM window_summary"
```

MariaDB:
```sh
mysql -u taboutliner -p taboutliner -e "SELECT * FROM window_summary"
```

HTTP (daemon must be running):
```sh
curl -s -X POST http://127.0.0.1:7779/query \
  -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT node_type, COUNT(*) c FROM node GROUP BY node_type"}' | python3 -m json.tool
```

## Useful queries

```sql
-- All open windows with tab counts
SELECT * FROM window_summary WHERE is_open=1;

-- Duplicate URLs
SELECT url, COUNT(*) c FROM node WHERE url IS NOT NULL
GROUP BY url HAVING c > 1 ORDER BY c DESC;

-- Bulk retitle a domain
UPDATE node SET custom_title = REPLACE(title, 'Old Corp', 'New Corp')
WHERE url LIKE '%oldcorp.com%';

-- Delete empty saved windows
DELETE FROM node WHERE node_type='savedwin'
  AND id NOT IN (SELECT DISTINCT parent_id FROM node WHERE parent_id IS NOT NULL);
```
