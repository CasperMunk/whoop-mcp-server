import Database from 'better-sqlite3';
import { encrypt, decrypt, isEncrypted } from './crypto.js';
import type {
	WhoopTokens,
	WhoopCycle,
	WhoopRecovery,
	WhoopSleep,
	WhoopWorkout,
	DbCycle,
	DbRecovery,
	DbSleep,
	DbWorkout,
} from './types.js';

interface TokenRow {
	id: number;
	access_token: string;
	refresh_token: string;
	expires_at: number;
	updated_at: string;
}

interface SyncStateRow {
	id: number;
	last_sync_at: string | null;
	oldest_synced_date: string | null;
	newest_synced_date: string | null;
}

interface RecoveryTrendRow {
	date: string;
	recovery_score: number;
	hrv: number;
	rhr: number;
}

interface SleepTrendRow {
	date: string;
	total_sleep_hours: number;
	performance: number;
	efficiency: number;
}

interface StrainTrendRow {
	date: string;
	strain: number;
	calories: number;
}

interface DailyLoadRow {
	date: string;
	day_strain: number | null;
	workout_count: number;
	sports: string | null;
	next_recovery: number | null;
	next_hrv: number | null;
}

interface SleepDebtRow {
	date: string;
	actual_sleep_ms: number;
	baseline_ms: number | null;
	debt_ms: number | null;
	strain_ms: number | null;
	nap_ms: number | null;
	total_need_ms: number;
	performance: number | null;
	disturbances: number | null;
	cycles: number | null;
	shortfall_ms: number;
}

export class WhoopDatabase {
	private db: Database.Database;

	constructor(dbPath = './whoop.db') {
		this.db = new Database(dbPath);
		this.db.pragma('journal_mode = WAL');
		this.initSchema();
	}

	private initSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS tokens (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				access_token TEXT NOT NULL,
				refresh_token TEXT NOT NULL,
				expires_at INTEGER NOT NULL,
				updated_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS sync_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				last_sync_at TEXT,
				oldest_synced_date TEXT,
				newest_synced_date TEXT
			);

			CREATE TABLE IF NOT EXISTS cycles (
				id INTEGER PRIMARY KEY,
				user_id INTEGER NOT NULL,
				start_time TEXT NOT NULL,
				end_time TEXT,
				timezone_offset TEXT,
				score_state TEXT NOT NULL,
				strain REAL,
				kilojoule REAL,
				avg_hr INTEGER,
				max_hr INTEGER,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS recovery (
				id INTEGER PRIMARY KEY,
				user_id INTEGER NOT NULL,
				sleep_id TEXT,
				created_at TEXT NOT NULL,
				score_state TEXT NOT NULL,
				recovery_score INTEGER,
				resting_hr INTEGER,
				hrv_rmssd REAL,
				spo2 REAL,
				skin_temp REAL,
				user_calibrating INTEGER,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS sleep (
				id TEXT PRIMARY KEY,
				user_id INTEGER NOT NULL,
				cycle_id INTEGER,
				start_time TEXT NOT NULL,
				end_time TEXT NOT NULL,
				timezone_offset TEXT,
				is_nap INTEGER NOT NULL DEFAULT 0,
				score_state TEXT NOT NULL,
				total_in_bed_milli INTEGER,
				total_awake_milli INTEGER,
				total_no_data_milli INTEGER,
				total_light_milli INTEGER,
				total_deep_milli INTEGER,
				total_rem_milli INTEGER,
				sleep_cycle_count INTEGER,
				disturbance_count INTEGER,
				sleep_performance REAL,
				sleep_efficiency REAL,
				sleep_consistency REAL,
				respiratory_rate REAL,
				sleep_needed_baseline_milli INTEGER,
				sleep_needed_debt_milli INTEGER,
				sleep_needed_strain_milli INTEGER,
				sleep_needed_nap_milli INTEGER,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS workouts (
				id TEXT PRIMARY KEY,
				v1_id INTEGER,
				user_id INTEGER NOT NULL,
				sport_id INTEGER NOT NULL,
				sport_name TEXT,
				start_time TEXT NOT NULL,
				end_time TEXT NOT NULL,
				timezone_offset TEXT,
				score_state TEXT NOT NULL,
				strain REAL,
				avg_hr INTEGER,
				max_hr INTEGER,
				kilojoule REAL,
				percent_recorded REAL,
				distance_meter REAL,
				altitude_gain_meter REAL,
				altitude_change_meter REAL,
				zone_zero_milli INTEGER,
				zone_one_milli INTEGER,
				zone_two_milli INTEGER,
				zone_three_milli INTEGER,
				zone_four_milli INTEGER,
				zone_five_milli INTEGER,
				created_at TEXT,
				updated_at TEXT,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS healthkit_samples (
				metric TEXT NOT NULL,
				date TEXT NOT NULL,
				qty REAL NOT NULL,
				units TEXT,
				received_at TEXT DEFAULT CURRENT_TIMESTAMP,
				PRIMARY KEY (metric, date, qty)
			);

			CREATE TABLE IF NOT EXISTS garmin_tokens (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				oauth1_token TEXT NOT NULL,
				oauth2_token TEXT NOT NULL,
				updated_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS garmin_body_composition (
				sample_pk INTEGER PRIMARY KEY,
				calendar_date TEXT NOT NULL,
				timestamp_gmt INTEGER NOT NULL,
				weight_g REAL NOT NULL,
				bmi REAL,
				body_fat_pct REAL,
				body_water_pct REAL,
				bone_mass_g REAL,
				muscle_mass_g REAL,
				physique_rating INTEGER,
				visceral_fat INTEGER,
				metabolic_age INTEGER,
				source_type TEXT,
				synced_at TEXT DEFAULT CURRENT_TIMESTAMP
			);

			CREATE TABLE IF NOT EXISTS garmin_sync_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				body_comp_synced_at TEXT
			);

			CREATE INDEX IF NOT EXISTS idx_cycles_start ON cycles(start_time);
			CREATE INDEX IF NOT EXISTS idx_recovery_created ON recovery(created_at);
			CREATE INDEX IF NOT EXISTS idx_sleep_start ON sleep(start_time);
			CREATE INDEX IF NOT EXISTS idx_workouts_start ON workouts(start_time);
			CREATE INDEX IF NOT EXISTS idx_hk_metric_date ON healthkit_samples(metric, date);
			CREATE INDEX IF NOT EXISTS idx_garmin_bc_date ON garmin_body_composition(calendar_date);

			INSERT OR IGNORE INTO garmin_sync_state (id) VALUES (1);

			INSERT OR IGNORE INTO sync_state (id) VALUES (1);
		`);

		this.migrateColumns('workouts', [
			['sport_name', 'TEXT'],
			['timezone_offset', 'TEXT'],
			['percent_recorded', 'REAL'],
			['created_at', 'TEXT'],
			['updated_at', 'TEXT'],
			['v1_id', 'INTEGER'],
			['distance_meter', 'REAL'],
			['altitude_gain_meter', 'REAL'],
			['altitude_change_meter', 'REAL'],
		]);
		this.migrateColumns('cycles', [
			['timezone_offset', 'TEXT'],
		]);
		this.migrateColumns('recovery', [
			['user_calibrating', 'INTEGER'],
		]);
		this.migrateColumns('sleep', [
			['total_no_data_milli', 'INTEGER'],
			['sleep_cycle_count', 'INTEGER'],
			['disturbance_count', 'INTEGER'],
			['sleep_needed_nap_milli', 'INTEGER'],
			['timezone_offset', 'TEXT'],
		]);

		// Whoop labels a cycle with the local date on which its opening sleep ended
		// (the morning you wake up), not the date it started: cycles begin at sleep
		// onset, which is often the evening before. Every day-level query reads the
		// label from here so sleep, strain and recovery always agree.
		// Fallbacks, in order: the sleep the cycle's recovery points at, the cycle's
		// own non-nap sleep, the recovery's creation time, and finally (an open cycle
		// whose sleep is not scored yet) the cycle start plus 12 hours.
		// Rows synced before offsets were stored have NULL offsets and fall back to UTC.
		this.db.exec(`
			DROP VIEW IF EXISTS cycle_days;
			CREATE VIEW cycle_days AS
			SELECT
				c.*,
				COALESCE(
					DATE(rs.end_time, COALESCE(rs.timezone_offset, c.timezone_offset, '+00:00')),
					DATE(cs.end_time, COALESCE(cs.timezone_offset, c.timezone_offset, '+00:00')),
					DATE(r.created_at, COALESCE(c.timezone_offset, '+00:00')),
					DATE(c.start_time, COALESCE(c.timezone_offset, '+00:00'), '+12 hours')
				) AS day
			FROM cycles c
			LEFT JOIN recovery r ON r.id = c.id
			LEFT JOIN sleep rs ON rs.id = r.sleep_id
			LEFT JOIN sleep cs ON cs.id = (
				SELECT s.id FROM sleep s
				WHERE s.cycle_id = c.id AND s.is_nap = 0
				ORDER BY julianday(s.start_time) LIMIT 1
			);
		`);
	}

	private migrateColumns(table: string, additions: Array<[string, string]>): void {
		const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
		for (const [name, def] of additions) {
			if (!cols.some(c => c.name === name)) {
				this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
			}
		}
	}

	saveTokens(tokens: WhoopTokens): void {
		const encryptedAccess = encrypt(tokens.access_token);
		const encryptedRefresh = encrypt(tokens.refresh_token);

		this.db.prepare(`
			INSERT OR REPLACE INTO tokens (id, access_token, refresh_token, expires_at, updated_at)
			VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)
		`).run(encryptedAccess, encryptedRefresh, tokens.expires_at);
	}

	getTokens(): WhoopTokens | null {
		const row = this.db.prepare('SELECT * FROM tokens WHERE id = 1').get() as TokenRow | undefined;
		if (!row) return null;

		const accessToken = isEncrypted(row.access_token)
			? decrypt(row.access_token)
			: row.access_token;

		const refreshToken = isEncrypted(row.refresh_token)
			? decrypt(row.refresh_token)
			: row.refresh_token;

		return {
			access_token: accessToken,
			refresh_token: refreshToken,
			expires_at: row.expires_at,
		};
	}

	getSyncState(): { lastSyncAt: string | null; oldestDate: string | null; newestDate: string | null } {
		const row = this.db.prepare('SELECT * FROM sync_state WHERE id = 1').get() as SyncStateRow | undefined;
		return {
			lastSyncAt: row?.last_sync_at ?? null,
			oldestDate: row?.oldest_synced_date ?? null,
			newestDate: row?.newest_synced_date ?? null,
		};
	}

	updateSyncState(oldestDate: string, newestDate: string): void {
		this.db.prepare(`
			UPDATE sync_state
			SET last_sync_at = CURRENT_TIMESTAMP,
				oldest_synced_date = COALESCE(
					CASE WHEN oldest_synced_date IS NULL OR ? < oldest_synced_date THEN ? ELSE oldest_synced_date END,
					?
				),
				newest_synced_date = COALESCE(
					CASE WHEN newest_synced_date IS NULL OR ? > newest_synced_date THEN ? ELSE newest_synced_date END,
					?
				)
			WHERE id = 1
		`).run(oldestDate, oldestDate, oldestDate, newestDate, newestDate, newestDate);
	}

	upsertCycles(cycles: WhoopCycle[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO cycles (id, user_id, start_time, end_time, timezone_offset, score_state, strain, kilojoule, avg_hr, max_hr, synced_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);

		const insertMany = this.db.transaction((items: WhoopCycle[]) => {
			for (const c of items) {
				stmt.run(
					c.id,
					c.user_id,
					c.start,
					c.end,
					c.timezone_offset ?? null,
					c.score_state,
					c.score?.strain ?? null,
					c.score?.kilojoule ?? null,
					c.score?.average_heart_rate ?? null,
					c.score?.max_heart_rate ?? null
				);
			}
		});

		insertMany(cycles);
	}

	upsertRecoveries(recoveries: WhoopRecovery[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO recovery (id, user_id, sleep_id, created_at, score_state, recovery_score, resting_hr, hrv_rmssd, spo2, skin_temp, user_calibrating, synced_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);

		const insertMany = this.db.transaction((items: WhoopRecovery[]) => {
			for (const r of items) {
				const calibrating = r.score?.user_calibrating;
				stmt.run(
					r.cycle_id,
					r.user_id,
					r.sleep_id,
					r.created_at,
					r.score_state,
					r.score?.recovery_score ?? null,
					r.score?.resting_heart_rate ?? null,
					r.score?.hrv_rmssd_milli ?? null,
					r.score?.spo2_percentage ?? null,
					r.score?.skin_temp_celsius ?? null,
					calibrating === undefined ? null : (calibrating ? 1 : 0)
				);
			}
		});

		insertMany(recoveries);
	}

	upsertSleeps(sleeps: WhoopSleep[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO sleep (
				id, user_id, cycle_id, start_time, end_time, timezone_offset, is_nap, score_state,
				total_in_bed_milli, total_awake_milli, total_no_data_milli,
				total_light_milli, total_deep_milli, total_rem_milli,
				sleep_cycle_count, disturbance_count,
				sleep_performance, sleep_efficiency, sleep_consistency, respiratory_rate,
				sleep_needed_baseline_milli, sleep_needed_debt_milli, sleep_needed_strain_milli, sleep_needed_nap_milli,
				synced_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);

		const insertMany = this.db.transaction((items: WhoopSleep[]) => {
			for (const s of items) {
				stmt.run(
					s.id,
					s.user_id,
					s.cycle_id ?? null,
					s.start,
					s.end,
					s.timezone_offset ?? null,
					s.nap ? 1 : 0,
					s.score_state,
					s.score?.stage_summary.total_in_bed_time_milli ?? null,
					s.score?.stage_summary.total_awake_time_milli ?? null,
					s.score?.stage_summary.total_no_data_time_milli ?? null,
					s.score?.stage_summary.total_light_sleep_time_milli ?? null,
					s.score?.stage_summary.total_slow_wave_sleep_time_milli ?? null,
					s.score?.stage_summary.total_rem_sleep_time_milli ?? null,
					s.score?.stage_summary.sleep_cycle_count ?? null,
					s.score?.stage_summary.disturbance_count ?? null,
					s.score?.sleep_performance_percentage ?? null,
					s.score?.sleep_efficiency_percentage ?? null,
					s.score?.sleep_consistency_percentage ?? null,
					s.score?.respiratory_rate ?? null,
					s.score?.sleep_needed.baseline_milli ?? null,
					s.score?.sleep_needed.need_from_sleep_debt_milli ?? null,
					s.score?.sleep_needed.need_from_recent_strain_milli ?? null,
					s.score?.sleep_needed.need_from_recent_nap_milli ?? null
				);
			}
		});

		insertMany(sleeps);
	}

	upsertWorkouts(workouts: WhoopWorkout[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO workouts (
				id, v1_id, user_id, sport_id, sport_name, start_time, end_time, timezone_offset, score_state,
				strain, avg_hr, max_hr, kilojoule, percent_recorded,
				distance_meter, altitude_gain_meter, altitude_change_meter,
				zone_zero_milli, zone_one_milli, zone_two_milli, zone_three_milli, zone_four_milli, zone_five_milli,
				created_at, updated_at, synced_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);

		const insertMany = this.db.transaction((items: WhoopWorkout[]) => {
			for (const w of items) {
				stmt.run(
					w.id,
					w.v1_id ?? null,
					w.user_id,
					w.sport_id,
					w.sport_name ?? null,
					w.start,
					w.end,
					w.timezone_offset ?? null,
					w.score_state,
					w.score?.strain ?? null,
					w.score?.average_heart_rate ?? null,
					w.score?.max_heart_rate ?? null,
					w.score?.kilojoule ?? null,
					w.score?.percent_recorded ?? null,
					w.score?.distance_meter ?? null,
					w.score?.altitude_gain_meter ?? null,
					w.score?.altitude_change_meter ?? null,
					w.score?.zone_durations?.zone_zero_milli ?? null,
					w.score?.zone_durations?.zone_one_milli ?? null,
					w.score?.zone_durations?.zone_two_milli ?? null,
					w.score?.zone_durations?.zone_three_milli ?? null,
					w.score?.zone_durations?.zone_four_milli ?? null,
					w.score?.zone_durations?.zone_five_milli ?? null,
					w.created_at ?? null,
					w.updated_at ?? null
				);
			}
		});

		insertMany(workouts);
	}

	getLatestCycle(): DbCycle | null {
		return this.db.prepare('SELECT * FROM cycles ORDER BY start_time DESC LIMIT 1').get() as DbCycle | undefined ?? null;
	}

	getLatestCompletedCycle(): DbCycle | null {
		return this.db.prepare('SELECT * FROM cycles WHERE end_time IS NOT NULL ORDER BY start_time DESC LIMIT 1').get() as DbCycle | undefined ?? null;
	}

	getLatestRecovery(): DbRecovery | null {
		return this.db.prepare('SELECT * FROM recovery ORDER BY created_at DESC LIMIT 1').get() as DbRecovery | undefined ?? null;
	}

	getLatestSleep(): DbSleep | null {
		return this.db.prepare('SELECT * FROM sleep WHERE is_nap = 0 ORDER BY start_time DESC LIMIT 1').get() as DbSleep | undefined ?? null;
	}

	getCyclesByDateRange(startDate: string, endDate: string): DbCycle[] {
		return this.db.prepare(`
			SELECT * FROM cycles WHERE start_time >= ? AND start_time <= ? ORDER BY start_time DESC
		`).all(startDate, endDate) as DbCycle[];
	}

	getRecoveriesByDateRange(startDate: string, endDate: string): DbRecovery[] {
		return this.db.prepare(`
			SELECT * FROM recovery WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC
		`).all(startDate, endDate) as DbRecovery[];
	}

	getSleepsByDateRange(startDate: string, endDate: string, includeNaps = false): DbSleep[] {
		const query = includeNaps
			? 'SELECT * FROM sleep WHERE start_time >= ? AND start_time <= ? ORDER BY start_time DESC'
			: 'SELECT * FROM sleep WHERE start_time >= ? AND start_time <= ? AND is_nap = 0 ORDER BY start_time DESC';
		return this.db.prepare(query).all(startDate, endDate) as DbSleep[];
	}

	getWorkoutsByDateRange(startDate: string, endDate: string): DbWorkout[] {
		return this.db.prepare(`
			SELECT * FROM workouts WHERE start_time >= ? AND start_time <= ? ORDER BY start_time DESC
		`).all(startDate, endDate) as DbWorkout[];
	}

	getRecoveryTrends(days: number): RecoveryTrendRow[] {
		return this.db.prepare(`
			SELECT COALESCE(cd.day, DATE(r.created_at)) as date, r.recovery_score, r.hrv_rmssd as hrv, r.resting_hr as rhr
			FROM recovery r
			LEFT JOIN cycle_days cd ON cd.id = r.id
			WHERE r.recovery_score IS NOT NULL AND COALESCE(cd.day, DATE(r.created_at)) >= DATE('now', '-' || ? || ' days')
			ORDER BY r.created_at DESC
		`).all(days) as RecoveryTrendRow[];
	}

	getSleepTrends(days: number): SleepTrendRow[] {
		return this.db.prepare(`
			SELECT DATE(s.end_time, COALESCE(s.timezone_offset, c.timezone_offset, '+00:00')) as date,
				ROUND((s.total_in_bed_milli - s.total_awake_milli) / 3600000.0, 2) as total_sleep_hours,
				s.sleep_performance as performance, s.sleep_efficiency as efficiency
			FROM sleep s
			LEFT JOIN cycles c ON c.id = s.cycle_id
			WHERE s.is_nap = 0 AND s.sleep_performance IS NOT NULL
				AND DATE(s.end_time, COALESCE(s.timezone_offset, c.timezone_offset, '+00:00')) >= DATE('now', '-' || ? || ' days')
			ORDER BY s.start_time DESC
		`).all(days) as SleepTrendRow[];
	}

	getWorkouts(days: number, minStrain?: number): DbWorkout[] {
		if (minStrain !== undefined) {
			return this.db.prepare(`
				SELECT * FROM workouts
				WHERE start_time >= DATE('now', '-' || ? || ' days')
					AND strain IS NOT NULL AND strain >= ?
				ORDER BY start_time DESC
			`).all(days, minStrain) as DbWorkout[];
		}
		return this.db.prepare(`
			SELECT * FROM workouts
			WHERE start_time >= DATE('now', '-' || ? || ' days')
			ORDER BY start_time DESC
		`).all(days) as DbWorkout[];
	}

	getAvgHrv(days: number): number | null {
		const row = this.db.prepare(`
			SELECT AVG(hrv_rmssd) as avg FROM recovery
			WHERE hrv_rmssd IS NOT NULL AND created_at >= DATE('now', '-' || ? || ' days')
		`).get(days) as { avg: number | null } | undefined;
		return row?.avg ?? null;
	}

	getAvgRhr(days: number): number | null {
		const row = this.db.prepare(`
			SELECT AVG(resting_hr) as avg FROM recovery
			WHERE resting_hr IS NOT NULL AND created_at >= DATE('now', '-' || ? || ' days')
		`).get(days) as { avg: number | null } | undefined;
		return row?.avg ?? null;
	}

	getDailyTrainingLoad(days: number): DailyLoadRow[] {
		return this.db.prepare(`
			WITH ranged AS (
				SELECT
					cd.*,
					julianday(cd.start_time) as start_jd,
					COALESCE(julianday(cd.end_time), julianday('now')) as end_jd
				FROM cycle_days cd
			)
			SELECT
				c.day as date,
				c.strain as day_strain,
				(SELECT COUNT(*) FROM workouts w
					WHERE julianday(w.start_time) >= c.start_jd AND julianday(w.start_time) < c.end_jd
						AND w.strain IS NOT NULL) as workout_count,
				(SELECT GROUP_CONCAT(DISTINCT COALESCE(sport_name, 'sport#' || sport_id))
					FROM workouts w
					WHERE julianday(w.start_time) >= c.start_jd AND julianday(w.start_time) < c.end_jd) as sports,
				nr.recovery_score as next_recovery,
				nr.hrv_rmssd as next_hrv
			FROM ranged c
			-- Next-day recovery is the recovery of the cycle that follows, i.e. the
			-- morning after this day's sleep. If that cycle has no recovery, it stays NULL.
			LEFT JOIN recovery nr ON nr.id = (
				SELECT n.id FROM cycles n
				WHERE julianday(n.start_time) > c.start_jd
				ORDER BY julianday(n.start_time) LIMIT 1
			)
			WHERE c.strain IS NOT NULL
				AND c.day >= DATE('now', '-' || ? || ' days')
			ORDER BY c.start_jd DESC
		`).all(days) as DailyLoadRow[];
	}

	getSleepDebtTrend(days: number): SleepDebtRow[] {
		return this.db.prepare(`
			SELECT
				DATE(s.end_time, COALESCE(s.timezone_offset, c.timezone_offset, '+00:00')) as date,
				(COALESCE(total_in_bed_milli, 0)
					- COALESCE(total_awake_milli, 0)
					- COALESCE(total_no_data_milli, 0)) as actual_sleep_ms,
				sleep_needed_baseline_milli as baseline_ms,
				sleep_needed_debt_milli as debt_ms,
				sleep_needed_strain_milli as strain_ms,
				sleep_needed_nap_milli as nap_ms,
				(COALESCE(sleep_needed_baseline_milli, 0)
					+ COALESCE(sleep_needed_debt_milli, 0)
					+ COALESCE(sleep_needed_strain_milli, 0)
					+ COALESCE(sleep_needed_nap_milli, 0)) as total_need_ms,
				sleep_performance as performance,
				disturbance_count as disturbances,
				sleep_cycle_count as cycles,
				((COALESCE(sleep_needed_baseline_milli, 0)
					+ COALESCE(sleep_needed_debt_milli, 0)
					+ COALESCE(sleep_needed_strain_milli, 0)
					+ COALESCE(sleep_needed_nap_milli, 0))
					- (COALESCE(total_in_bed_milli, 0)
						- COALESCE(total_awake_milli, 0)
						- COALESCE(total_no_data_milli, 0))) as shortfall_ms
			FROM sleep s
			LEFT JOIN cycles c ON c.id = s.cycle_id
			WHERE s.is_nap = 0
				AND s.sleep_needed_baseline_milli IS NOT NULL
				AND DATE(s.end_time, COALESCE(s.timezone_offset, c.timezone_offset, '+00:00')) >= DATE('now', '-' || ? || ' days')
			ORDER BY s.start_time DESC
		`).all(days) as SleepDebtRow[];
	}

	getStrainTrends(days: number): StrainTrendRow[] {
		return this.db.prepare(`
			SELECT day as date, strain, ROUND(kilojoule / 4.184, 0) as calories
			FROM cycle_days
			WHERE strain IS NOT NULL AND day >= DATE('now', '-' || ? || ' days')
			ORDER BY start_time DESC
		`).all(days) as StrainTrendRow[];
	}

	upsertHealthkitSamples(samples: Array<{ metric: string; date: string; qty: number; units: string | null }>): number {
		const stmt = this.db.prepare(`
			INSERT OR IGNORE INTO healthkit_samples (metric, date, qty, units, received_at)
			VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);
		let inserted = 0;
		const tx = this.db.transaction((items: typeof samples) => {
			for (const s of items) {
				const res = stmt.run(s.metric, s.date, s.qty, s.units);
				inserted += res.changes;
			}
		});
		tx(samples);
		return inserted;
	}

	getHealthkitDailyTotals(days: number, metrics: string[]): Array<{ date: string; metric: string; total: number; count: number; units: string | null }> {
		if (metrics.length === 0) return [];
		const placeholders = metrics.map(() => '?').join(',');
		return this.db.prepare(`
			SELECT DATE(date) as date, metric, SUM(qty) as total, COUNT(*) as count, MAX(units) as units
			FROM healthkit_samples
			WHERE metric IN (${placeholders})
				AND DATE(date) >= DATE('now', '-' || ? || ' days')
			GROUP BY DATE(date), metric
			ORDER BY DATE(date) DESC, metric
		`).all(...metrics, days) as Array<{ date: string; metric: string; total: number; count: number; units: string | null }>;
	}

	getHealthkitDailyAvg(days: number, metrics: string[]): Array<{ date: string; metric: string; avg: number; count: number; units: string | null }> {
		if (metrics.length === 0) return [];
		const placeholders = metrics.map(() => '?').join(',');
		return this.db.prepare(`
			SELECT DATE(date) as date, metric, AVG(qty) as avg, COUNT(*) as count, MAX(units) as units
			FROM healthkit_samples
			WHERE metric IN (${placeholders})
				AND DATE(date) >= DATE('now', '-' || ? || ' days')
			GROUP BY DATE(date), metric
			ORDER BY DATE(date) DESC, metric
		`).all(...metrics, days) as Array<{ date: string; metric: string; avg: number; count: number; units: string | null }>;
	}

	getHealthkitDayTotal(metric: string, daysAgo: number): { total: number; units: string | null } | null {
		const row = this.db.prepare(`
			SELECT SUM(qty) as total, MAX(units) as units
			FROM healthkit_samples
			WHERE metric = ? AND DATE(date) = DATE('now', '-' || ? || ' days')
		`).get(metric, daysAgo) as { total: number | null; units: string | null } | undefined;
		if (!row || row.total === null) return null;
		return { total: row.total, units: row.units };
	}

	getHealthkitSamples(metric: string, days: number): Array<{ date: string; qty: number; units: string | null }> {
		return this.db.prepare(`
			SELECT date, qty, units FROM healthkit_samples
			WHERE metric = ? AND DATE(date) >= DATE('now', '-' || ? || ' days')
			ORDER BY date DESC
		`).all(metric, days) as Array<{ date: string; qty: number; units: string | null }>;
	}

	getEnergyBalance(days: number): Array<{ date: string; kcal_in: number | null; kcal_out: number | null; protein_g: number | null }> {
		return this.db.prepare(`
			WITH windowed AS (
				SELECT
					day as date,
					datetime(start_time) as start_dt,
					COALESCE(datetime(end_time), datetime(start_time, '+24 hours')) as end_dt,
					ROUND(kilojoule / 4.184, 0) as kcal_out
				FROM cycle_days
				WHERE kilojoule IS NOT NULL
					AND start_time >= datetime('now', '-' || ? || ' days')
			)
			SELECT
				w.date,
				w.kcal_out,
				(SELECT SUM(CASE WHEN units = 'kJ' THEN qty / 4.184 ELSE qty END)
					FROM healthkit_samples
					WHERE metric = 'dietary_energy'
						AND datetime(date) >= w.start_dt
						AND datetime(date) < w.end_dt) as kcal_in,
				(SELECT SUM(qty) FROM healthkit_samples
					WHERE metric = 'protein'
						AND datetime(date) >= w.start_dt
						AND datetime(date) < w.end_dt) as protein_g
			FROM windowed w
			ORDER BY w.start_dt DESC
		`).all(days) as Array<{ date: string; kcal_in: number | null; kcal_out: number | null; protein_g: number | null }>;
	}

	upsertGarminBodyComposition(entries: Array<{
		samplePk: number;
		calendarDate: string;
		timestampGMT: number;
		weight: number;
		bmi: number | null;
		bodyFat: number | null;
		bodyWater: number | null;
		boneMass: number | null;
		muscleMass: number | null;
		physiqueRating: number | null;
		visceralFat: number | null;
		metabolicAge: number | null;
		sourceType: string;
	}>): number {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO garmin_body_composition
				(sample_pk, calendar_date, timestamp_gmt, weight_g, bmi, body_fat_pct, body_water_pct,
				 bone_mass_g, muscle_mass_g, physique_rating, visceral_fat, metabolic_age, source_type, synced_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`);
		const tx = this.db.transaction((items: typeof entries) => {
			for (const e of items) {
				stmt.run(
					e.samplePk, e.calendarDate, e.timestampGMT, e.weight,
					e.bmi, e.bodyFat, e.bodyWater, e.boneMass, e.muscleMass,
					e.physiqueRating, e.visceralFat, e.metabolicAge, e.sourceType
				);
			}
		});
		tx(entries);
		this.db.prepare('UPDATE garmin_sync_state SET body_comp_synced_at = CURRENT_TIMESTAMP WHERE id = 1').run();
		return entries.length;
	}

	getGarminBodyCompositionSyncedAt(): string | null {
		const row = this.db.prepare('SELECT body_comp_synced_at FROM garmin_sync_state WHERE id = 1').get() as
			{ body_comp_synced_at: string | null } | undefined;
		return row?.body_comp_synced_at ?? null;
	}

	getGarminBodyComposition(days: number): Array<{
		calendar_date: string;
		timestamp_gmt: number;
		weight_kg: number;
		bmi: number | null;
		body_fat_pct: number | null;
		body_water_pct: number | null;
		bone_mass_kg: number | null;
		muscle_mass_kg: number | null;
		physique_rating: number | null;
		visceral_fat: number | null;
		metabolic_age: number | null;
		source_type: string;
	}> {
		return this.db.prepare(`
			SELECT
				calendar_date,
				timestamp_gmt,
				weight_g / 1000.0 as weight_kg,
				bmi,
				body_fat_pct,
				body_water_pct,
				bone_mass_g / 1000.0 as bone_mass_kg,
				muscle_mass_g / 1000.0 as muscle_mass_kg,
				physique_rating,
				visceral_fat,
				metabolic_age,
				source_type
			FROM garmin_body_composition
			WHERE calendar_date >= DATE('now', '-' || ? || ' days')
			ORDER BY timestamp_gmt DESC
		`).all(days) as Array<{
			calendar_date: string;
			timestamp_gmt: number;
			weight_kg: number;
			bmi: number | null;
			body_fat_pct: number | null;
			body_water_pct: number | null;
			bone_mass_kg: number | null;
			muscle_mass_kg: number | null;
			physique_rating: number | null;
			visceral_fat: number | null;
			metabolic_age: number | null;
			source_type: string;
		}>;
	}

	close(): void {
		this.db.close();
	}
}
