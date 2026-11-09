import { access, copyFile, mkdir, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StartupFailure } from './app-runtime.mjs';

export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const failure = declaration => new StartupFailure('seed_failed', declaration.name, { hint: 'Set the declared connection variable to a local datastore address.' });
const sqlString = value => `'${value.replaceAll("'", "''")}'`;
const sqlName = value => `"${value.replaceAll('"', '""')}"`;
const mysqlName = value => '`' + value.replaceAll('`', '``') + '`';
const commandRunner = (processes, declaration, env = {}) => (command, options) => processes.run(command, { stage: `seed:${declaration.name}`, reason: 'seed_failed', env, ...options });

function connection(declaration, processes, kinds, port) {
  let url;
  try { url = new URL(processes.env[declaration.connection_env]); } catch { throw failure(declaration); }
  if (!kinds.includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.search || url.hash) throw failure(declaration);
  const password = decodeURIComponent(url.password);
  if (password) processes.secrets.push(password);
  return { port: url.port || String(port), user: decodeURIComponent(url.username), password, database: decodeURIComponent(url.pathname.slice(1)) };
}

async function pgBinary(processes, name) {
  try { return await processes.executable(name); } catch (error) {
    // Debian installs server tools outside PATH, unlike its client tools.
    for (const version of (await readdir('/usr/lib/postgresql').catch(() => [])).sort().reverse()) {
      const path = join('/usr/lib/postgresql', version, 'bin', name);
      try { await access(path, constants.X_OK); return path; } catch {}
    }
    throw error;
  }
}

export async function postgresAdapter({ declaration, processes, directory }) {
  const config = connection(declaration, processes, ['postgres:', 'postgresql:'], 5432);
  const binaries = Object.fromEntries(await Promise.all(['postgres', 'initdb', 'psql', 'pg_dump', 'pg_restore'].map(async name => [name, quote(await pgBinary(processes, name))])));
  const data = join(directory, declaration.name + '-postgres');
  const socket = join(directory, declaration.name + '-socket');
  const database = config.database || 'postgres';
  const env = { PGHOST: '127.0.0.1', PGPORT: config.port, PGUSER: config.user || 'postgres', PGPASSWORD: config.password, PGDATABASE: database };
  const run = commandRunner(processes, declaration, env);
  const admin = content => `${binaries.psql} --no-psqlrc --set=ON_ERROR_STOP=1 --dbname=postgres --command=${quote(content)}`;
  return {
    env,
    async prepare(options) {
      if (declaration.start) return;
      await mkdir(data, { mode: 0o700 }); await mkdir(socket, { mode: 0o700 });
      await run(`${binaries.initdb} -D ${quote(data)} --username=${quote(env.PGUSER)} --auth=trust --no-locale --encoding=UTF8`, options);
    },
    start: `${binaries.postgres} -D ${quote(data)} -h 127.0.0.1 -p ${quote(config.port)} -k ${quote(socket)}`,
    ready: admin('SELECT 1'),
    async initialize(options) {
      const result = await run(`${binaries.psql} --no-psqlrc --tuples-only --no-align --dbname=postgres --command=${quote(`SELECT 1 FROM pg_database WHERE datname=${sqlString(database)}`)}`, options);
      if (result.stdout.toString('utf8').trim() !== '1') await run(admin(`CREATE DATABASE ${sqlName(database)}`), options);
    },
    load: (input, options) => run(`${binaries.psql} --no-psqlrc --set=ON_ERROR_STOP=1`, { ...options, input }),
    capture: (archive, options) => run(`${binaries.pg_dump} --format=custom --compress=0 --no-owner --no-acl --file=${quote(archive)}`, options),
    async restore(archive, options) {
      // Dropping the complete database removes records/tables created by the
      // previous chain, including objects absent from the captured snapshot.
      const adminDatabase = database === 'postgres' ? 'template1' : 'postgres';
      const control = sql => `${binaries.psql} --no-psqlrc --set=ON_ERROR_STOP=1 --dbname=${quote(adminDatabase)} --command=${quote(sql)}`;
      await run(control(`DROP DATABASE ${sqlName(database)} WITH (FORCE)`), options);
      await run(control(`CREATE DATABASE ${sqlName(database)}`), options);
      await run(`${binaries.pg_restore} --exit-on-error --no-owner --no-acl --dbname=${quote(database)} ${quote(archive)}`, options);
    },
  };
}

async function alternative(processes, names) {
  for (const name of names) { try { return quote(await processes.executable(name)); } catch {} }
  throw new StartupFailure('missing_tool', names[0]);
}
export async function mysqlAdapter({ declaration, processes, directory }) {
  const config = connection(declaration, processes, ['mysql:', 'mariadb:'], 3306);
  if (!config.database || ['mysql', 'sys', 'information_schema', 'performance_schema'].includes(config.database)) throw failure(declaration);
  const server = await alternative(processes, ['mariadbd', 'mysqld']);
  const client = await alternative(processes, ['mariadb', 'mysql']);
  const dump = await alternative(processes, ['mariadb-dump', 'mysqldump']);
  const initialize = declaration.start ? undefined : await alternative(processes, ['mariadb-install-db', 'mysql_install_db']).catch(() => undefined);
  const data = join(directory, declaration.name + '-mysql'), socket = join(directory, declaration.name + '.sock');
  const env = { MYSQL_PWD: config.password };
  const run = commandRunner(processes, declaration, env);
  const options = `--protocol=TCP --host=127.0.0.1 --port=${quote(config.port)} --user=${quote(config.user || 'root')}`;
  const admin = sql => `${client} ${options} --execute=${quote(sql)}`;
  return {
    env,
    async prepare(options) {
      if (declaration.start) return;
      await mkdir(data, { mode: 0o700 });
      await run(initialize ? `${initialize} --no-defaults --datadir=${quote(data)} --auth-root-authentication-method=normal --skip-test-db` : `${server} --no-defaults --initialize-insecure --datadir=${quote(data)}`, options);
    },
    // The disposable server is accessible only inside the isolated app. Local
    // database transport credentials never become seed contents.
    start: `${server} --no-defaults --datadir=${quote(data)} --socket=${quote(socket)} --pid-file=${quote(join(data, 'server.pid'))} --bind-address=127.0.0.1 --port=${quote(config.port)} --skip-grant-tables`,
    ready: admin('SELECT 1'),
    initialize: options => run(admin(`CREATE DATABASE IF NOT EXISTS ${mysqlName(config.database)}`), options),
    load: (input, settings) => run(`${client} ${options} --database=${quote(config.database)}`, { ...settings, input }),
    capture: (archive, settings) => run(`${dump} ${options} --single-transaction --skip-comments --skip-dump-date --routines --events ${quote(config.database)} > ${quote(archive)}`, settings),
    async restore(archive, settings) {
      await run(admin(`DROP DATABASE IF EXISTS ${mysqlName(config.database)}; CREATE DATABASE ${mysqlName(config.database)}`), settings);
      await run(`${client} ${options} --database=${quote(config.database)} < ${quote(archive)}`, settings);
    },
  };
}

export async function redisAdapter({ declaration, processes, directory }) {
  const config = connection(declaration, processes, ['redis:'], 6379);
  if (config.user && config.user !== 'default' || config.database && !/^\d+$/.test(config.database)) throw failure(declaration);
  const server = quote(await processes.executable('redis-server')), client = quote(await processes.executable('redis-cli'));
  const data = join(directory, declaration.name + '-redis'), configuration = join(data, 'redis.conf');
  const env = { REDISCLI_AUTH: config.password || undefined };
  const cli = `${client} --no-auth-warning -h 127.0.0.1 -p ${quote(config.port)} -n ${quote(config.database || '0')}`;
  const run = commandRunner(processes, declaration, env);
  return {
    env,
    async prepare() {
      if (declaration.start) return;
      await mkdir(data, { mode: 0o700 });
      await writeFile(configuration, ['bind 127.0.0.1', `port ${config.port}`, `dir ${JSON.stringify(data)}`, 'dbfilename dump.rdb', 'appendonly no', 'save ""', 'enable-debug-command local', ...(config.password ? [`requirepass ${JSON.stringify(config.password)}`] : [])].join('\n'), { mode: 0o600 });
    },
    start: `${server} ${quote(configuration)}`,
    ready: `${cli} --raw PING | ${quote(await processes.executable('grep'))} -qx PONG`,
    load: (input, options) => run(`${cli} --pipe`, { ...options, input }),
    capture: (archive, options) => run(`${cli} --rdb ${quote(archive)}`, options),
    async restore(archive, options) {
      const directory = JSON.parse((await run(`${cli} --json CONFIG GET dir`, options)).stdout.toString('utf8'));
      const filename = JSON.parse((await run(`${cli} --json CONFIG GET dbfilename`, options)).stdout.toString('utf8'));
      await copyFile(archive, join(directory.dir ?? directory[1], filename.dbfilename ?? filename[1]));
      // DEBUG RELOAD is enabled only on this loopback-only disposable server.
      // NOSAVE ensures mutations from the preceding chain cannot overwrite it.
      await run(`${cli} DEBUG RELOAD NOSAVE | ${quote(await processes.executable('grep'))} -qx OK`, options);
    },
  };
}

export async function filesAdapter({ declaration, processes, root, maxSize = 2 * 1024 ** 3 }) {
  const configured = declaration.path || processes.env[declaration.connection_env];
  if (!configured) throw failure(declaration);
  const base = await realpath(root), path = resolve(processes.cwd, configured);
  const contained = candidate => { const rel = relative(base, candidate); return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep); };
  if (!contained(path)) throw failure(declaration);
  // Check every existing ancestor before mkdir; a repository symlink cannot
  // redirect extraction outside the application tree.
  let parent = path;
  while (parent !== base) {
    try { if (!contained(await realpath(parent))) throw failure(declaration); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; parent = dirname(parent); }
  }
  await mkdir(path, { recursive: true });
  if (!(await stat(path)).isDirectory()) throw failure(declaration);
  const python = quote(await processes.executable('python3'));
  const script = quote(fileURLToPath(new URL('./seed-archive.py', import.meta.url)));
  const run = commandRunner(processes, declaration);
  return {
    async validate(archive, options = {}) {
      try { await run(`${python} ${script} validate ${quote(base)} ${quote(path)} ${quote(archive)} ${quote(options.maxSize ?? maxSize)}`, options); }
      catch (error) { if (error.details?.exit_code === 1) throw new StartupFailure('seed_corrupt', declaration.name); throw error; }
    },
    async capture(archive, options = {}) {
      try { await run(`${python} ${script} capture ${quote(base)} ${quote(path)} ${quote(archive)} ${quote(options.maxSize ?? maxSize)}`, options); }
      catch (error) {
        if (error.details?.exit_code === 2) throw new StartupFailure('seed_too_large', declaration.name, { largest_archive: declaration.name, max_bytes: maxSize });
        throw error;
      }
    },
    async restore(archive, options = {}) {
      try { await run(`${python} ${script} restore ${quote(base)} ${quote(path)} ${quote(archive)} ${quote(options.maxSize ?? maxSize)}`, options); }
      catch (error) { if (error.details?.exit_code === 1) throw new StartupFailure('seed_corrupt', declaration.name); throw error; }
    },
  };
}

export const datastoreAdapters = { postgres: postgresAdapter, mysql: mysqlAdapter, redis: redisAdapter, files: filesAdapter };
