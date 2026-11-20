/* global db, print, process -- runs inside mongosh (docker-entrypoint-initdb.d), not Node */
// Runs once, on the first start of an EMPTY data volume (docker-entrypoint-initdb.d).
// Creates the application user with rights on the app database only (readWrite + dbAdmin for migrations).
const dbName = process.env.MONGO_APP_DB;
const user = process.env.MONGO_APP_USER;
const pwd = process.env.MONGO_APP_PASSWORD;
if (!dbName || !user || !pwd) throw new Error("MONGO_APP_DB / MONGO_APP_USER / MONGO_APP_PASSWORD must be set");

db.getSiblingDB(dbName).createUser({
  user,
  pwd,
  roles: [
    { role: "readWrite", db: dbName },
    { role: "dbAdmin", db: dbName },
  ],
});
print(`created application user "${user}" on database "${dbName}"`);
