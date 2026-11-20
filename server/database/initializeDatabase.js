export function initializeDatabase(db) {
db.exec(`
  CREATE TABLE IF NOT EXISTS pilots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    rates TEXT NOT NULL DEFAULT '',
    rate_profile_json TEXT,
    note TEXT NOT NULL DEFAULT '',
    channel_config_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS training_events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    started_at INTEGER,
    ended_at INTEGER,
    active INTEGER NOT NULL DEFAULT 0,
    participants_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS training_samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    pilot_id TEXT NOT NULL,
    receiver_id INTEGER NOT NULL,
    time INTEGER NOT NULL,
    ch1 INTEGER, ch2 INTEGER, ch3 INTEGER, ch4 INTEGER,
    ch5 INTEGER, ch6 INTEGER, ch7 INTEGER, ch8 INTEGER,
    throttle_min INTEGER, throttle_max INTEGER,
    armed INTEGER NOT NULL DEFAULT 0,
    flying INTEGER NOT NULL DEFAULT 0,
    turtle INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_training_samples_event_pilot_time
    ON training_samples(event_id, pilot_id, time);
  CREATE INDEX IF NOT EXISTS idx_training_samples_event_time
    ON training_samples(event_id, time, pilot_id);
  CREATE INDEX IF NOT EXISTS idx_training_samples_event_receiver_time
    ON training_samples(event_id, receiver_id, time);
  CREATE TABLE IF NOT EXISTS training_receiver_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    pilot_id TEXT NOT NULL,
    receiver_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_training_receiver_assignments_event_time
    ON training_receiver_assignments(event_id, started_at, ended_at);
  CREATE INDEX IF NOT EXISTS idx_training_receiver_assignments_event_pilot
    ON training_receiver_assignments(event_id, pilot_id, started_at);
  CREATE TABLE IF NOT EXISTS training_ingested_packets (
    event_id TEXT NOT NULL,
    packet_id TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    processed_at INTEGER NOT NULL,
    PRIMARY KEY (event_id, packet_id)
  );
  CREATE INDEX IF NOT EXISTS idx_training_ingested_packets_event_capture
    ON training_ingested_packets(event_id, captured_at);
  CREATE TABLE IF NOT EXISTS training_timeline_rebuild_queue (
    event_id TEXT PRIMARY KEY,
    marked_at INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS training_event_media (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    url TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    captured_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_training_event_media_event_time
    ON training_event_media(event_id, captured_at DESC, created_at DESC);
  CREATE TABLE IF NOT EXISTS training_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    pilot_id TEXT NOT NULL,
    type TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_training_segments_event_pilot
    ON training_segments(event_id, pilot_id);
  CREATE INDEX IF NOT EXISTS idx_training_segments_event_pilot_end
    ON training_segments(event_id, pilot_id, ended_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_training_segments_event_end
    ON training_segments(event_id, ended_at);
  CREATE TABLE IF NOT EXISTS training_event_stats (
    event_id TEXT NOT NULL,
    pilot_id TEXT NOT NULL,
    total_flight_ms INTEGER NOT NULL DEFAULT 0,
    utilization REAL NOT NULL DEFAULT 0,
    idle_ms INTEGER,
    total_turtle_ms INTEGER NOT NULL DEFAULT 0,
    last_flight_end_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (event_id, pilot_id)
  );
  CREATE TABLE IF NOT EXISTS training_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS receivers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    online INTEGER NOT NULL DEFAULT 1,
    binding INTEGER NOT NULL DEFAULT 0,
    bind_requested_at INTEGER,
    last_seen_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    trackdraw_project_id TEXT NOT NULL DEFAULT '',
    trackdraw_embed_url TEXT NOT NULL DEFAULT '',
    track_image_url TEXT NOT NULL DEFAULT '',
    track_json TEXT,
    overlay_json TEXT,
    field_width REAL,
    field_height REAL,
    route_length REAL,
    trackdraw_updated_at TEXT,
    sync_status TEXT NOT NULL DEFAULT 'pending',
    sync_error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS track_equipment (
    track_id TEXT NOT NULL,
    equipment_type TEXT NOT NULL,
    auto_quantity INTEGER NOT NULL DEFAULT 0,
    corrected_quantity INTEGER,
    final_quantity INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (track_id, equipment_type)
  );
  CREATE TABLE IF NOT EXISTS track_unknown_objects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    guessed_name TEXT NOT NULL DEFAULT '',
    assigned_equipment_type TEXT NOT NULL DEFAULT '',
    ignored INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS transport_rules (
    equipment_type TEXT PRIMARY KEY,
    people_required INTEGER NOT NULL DEFAULT 1,
    max_per_trip INTEGER NOT NULL DEFAULT 1,
    trip_time_minutes REAL NOT NULL DEFAULT 1,
    cart_required INTEGER NOT NULL DEFAULT 0,
    difficulty REAL NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS transport_plans (
    id TEXT PRIMARY KEY,
    track_id TEXT NOT NULL,
    plan_type TEXT NOT NULL DEFAULT 'search',
    title TEXT NOT NULL,
    people_count INTEGER NOT NULL DEFAULT 0,
    used_people_count INTEGER NOT NULL DEFAULT 0,
    estimated_minutes REAL NOT NULL DEFAULT 0,
    idle_minutes REAL NOT NULL DEFAULT 0,
    fatigue_score REAL NOT NULL DEFAULT 0,
    trip_imbalance REAL NOT NULL DEFAULT 0,
    plan_json TEXT NOT NULL,
    selected INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// Teaching management schema
db.exec(`
  CREATE TABLE IF NOT EXISTS skill_tree (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    star_criteria TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pilot_skill_progress (
    pilot_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    current_stars INTEGER NOT NULL DEFAULT 0,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (pilot_id, skill_id)
  );
  CREATE TABLE IF NOT EXISTS pilot_growth_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pilot_id TEXT NOT NULL,
    event_id TEXT,
    occurred_at INTEGER NOT NULL,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pilot_stratification (
    pilot_id TEXT PRIMARY KEY,
    training_roi REAL NOT NULL DEFAULT 50.0,
    award_potential REAL NOT NULL DEFAULT 3.0,
    parent_investment REAL NOT NULL DEFAULT 3.0,
    training_enthusiasm REAL NOT NULL DEFAULT 3.0,
    short_term_result_speed REAL NOT NULL DEFAULT 3.0,
    phase_value REAL NOT NULL DEFAULT 3.0,
    quadrant TEXT NOT NULL DEFAULT 'core',
    attention_weight REAL NOT NULL DEFAULT 0.25,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lesson_plan (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    pilot_id TEXT NOT NULL,
    target_skills TEXT NOT NULL DEFAULT '[]',
    training_tasks TEXT NOT NULL DEFAULT '[]',
    coach_visit_count INTEGER NOT NULL DEFAULT 2,
    coach_actions TEXT NOT NULL DEFAULT '[]',
    ai_suggestion TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS coach_session_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    pilot_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    action_label TEXT NOT NULL,
    target_skill_id TEXT,
    note TEXT NOT NULL DEFAULT '',
    recorded_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS coach_live_board (
    event_id TEXT NOT NULL,
    pilot_id TEXT NOT NULL,
    task_progress_json TEXT NOT NULL DEFAULT '[]',
    coach_visits_done INTEGER NOT NULL DEFAULT 0,
    coach_visits_required INTEGER NOT NULL DEFAULT 0,
    is_falling_behind INTEGER NOT NULL DEFAULT 0,
    anomaly_flags TEXT NOT NULL DEFAULT '[]',
    last_coach_action_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (event_id, pilot_id)
  );
  CREATE TABLE IF NOT EXISTS coach_task_status (
    event_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    completed_at INTEGER,
    completed_by TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (event_id, task_id)
  );
  CREATE TABLE IF NOT EXISTS coach_custom_tasks (
    event_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    minute INTEGER NOT NULL DEFAULT 0,
    action TEXT NOT NULL DEFAULT '自定义',
    priority TEXT NOT NULL DEFAULT 'normal',
    focus TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (event_id, task_id)
  );
  CREATE TABLE IF NOT EXISTS lesson_review (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    pilot_id TEXT NOT NULL,
    task_completion_pct REAL NOT NULL DEFAULT 0,
    coach_visit_count INTEGER NOT NULL DEFAULT 0,
    goal_achieved_skills TEXT NOT NULL DEFAULT '[]',
    deferred_skills TEXT NOT NULL DEFAULT '[]',
    star_recommendations TEXT NOT NULL DEFAULT '[]',
    overall_score REAL NOT NULL DEFAULT 0,
    coach_note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lesson_summary (
    event_id TEXT PRIMARY KEY,
    total_pilots INTEGER NOT NULL DEFAULT 0,
    avg_completion_pct REAL NOT NULL DEFAULT 0,
    attention_distribution TEXT NOT NULL DEFAULT '[]',
    time_allocation_json TEXT NOT NULL DEFAULT '{}',
    achieved_goal_count INTEGER NOT NULL DEFAULT 0,
    total_goal_count INTEGER NOT NULL DEFAULT 0,
    next_lesson_hints TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
`);

const pilotColumns = db.prepare("PRAGMA table_info(pilots)").all().map((column) => column.name);
if (!pilotColumns.includes("rate_profile_json")) {
  db.exec("ALTER TABLE pilots ADD COLUMN rate_profile_json TEXT");
}

const trainingEventStatColumns = db.prepare("PRAGMA table_info(training_event_stats)").all().map((column) => column.name);
if (!trainingEventStatColumns.includes("last_flight_end_at")) {
  db.exec("ALTER TABLE training_event_stats ADD COLUMN last_flight_end_at INTEGER");
}

const trainingSampleColumns = db.prepare("PRAGMA table_info(training_samples)").all().map((column) => column.name);
if (!trainingSampleColumns.includes("throttle_min")) {
  db.exec("ALTER TABLE training_samples ADD COLUMN throttle_min INTEGER");
}
if (!trainingSampleColumns.includes("throttle_max")) {
  db.exec("ALTER TABLE training_samples ADD COLUMN throttle_max INTEGER");
}

const trackColumns = db.prepare("PRAGMA table_info(tracks)").all().map((column) => column.name);
if (!trackColumns.includes("track_image_url")) {
  db.exec("ALTER TABLE tracks ADD COLUMN track_image_url TEXT NOT NULL DEFAULT ''");
}

const stratificationColumns = db.prepare("PRAGMA table_info(pilot_stratification)").all().map((column) => column.name);
if (!stratificationColumns.includes("short_term_result_speed")) {
  db.exec("ALTER TABLE pilot_stratification ADD COLUMN short_term_result_speed REAL NOT NULL DEFAULT 3.0");
}
const lessonReviewColumns = db.prepare("PRAGMA table_info(lesson_review)").all().map((column) => column.name);
if (!lessonReviewColumns.includes("quiz_result")) {
  db.exec("ALTER TABLE lesson_review ADD COLUMN quiz_result TEXT NOT NULL DEFAULT ''");
}
if (!lessonReviewColumns.includes("updated_at")) {
  db.exec("ALTER TABLE lesson_review ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
}

// Fleet ground-station schema. These tables deliberately do not reference the
// training pilots table: the fleet roster may import a training pilot as a
// read-only source, but it owns its own names and lifecycle.
db.exec(`
  CREATE TABLE IF NOT EXISTS fleet_pilots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_training_pilot_id TEXT,
    note TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_pilots_training_source
    ON fleet_pilots(source_training_pilot_id)
    WHERE source_training_pilot_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS fleet_aircraft (
    id TEXT PRIMARY KEY,
    serial_number TEXT NOT NULL,
    owner_pilot_id TEXT,
    model TEXT NOT NULL DEFAULT '',
    configuration_note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_aircraft_owner_serial
    ON fleet_aircraft(COALESCE(owner_pilot_id, ''), serial_number)
    WHERE status = 'active';

  CREATE TABLE IF NOT EXISTS fleet_flight_controllers (
    id TEXT PRIMARY KEY,
    device_uid TEXT NOT NULL UNIQUE,
    board_identifier TEXT NOT NULL DEFAULT '',
    board_name TEXT NOT NULL DEFAULT '',
    usb_vendor_id INTEGER,
    usb_product_id INTEGER,
    firmware_variant TEXT NOT NULL DEFAULT '',
    firmware_version TEXT NOT NULL DEFAULT '',
    api_version TEXT NOT NULL DEFAULT '',
    build_key TEXT NOT NULL DEFAULT '',
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS fleet_aircraft_controllers (
    id TEXT PRIMARY KEY,
    aircraft_id TEXT NOT NULL,
    flight_controller_id TEXT NOT NULL,
    installed_at INTEGER NOT NULL,
    removed_at INTEGER,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_controller_current_aircraft
    ON fleet_aircraft_controllers(flight_controller_id)
    WHERE removed_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_fleet_aircraft_controller_history
    ON fleet_aircraft_controllers(aircraft_id, installed_at);

  CREATE TABLE IF NOT EXISTS fleet_configuration_presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'team_baseline',
    board_identifier TEXT NOT NULL DEFAULT '',
    firmware_version TEXT NOT NULL DEFAULT '',
    pilot_id TEXT,
    parent_preset_id TEXT,
    version_number INTEGER NOT NULL DEFAULT 1,
    content TEXT NOT NULL,
    content_format TEXT NOT NULL DEFAULT 'betaflight_cli',
    content_hash TEXT NOT NULL,
    raw_cli_text TEXT NOT NULL DEFAULT '',
    canonical_snapshot TEXT NOT NULL DEFAULT '',
    mapping_version INTEGER NOT NULL DEFAULT 1,
    unmapped_cli_json TEXT NOT NULL DEFAULT '[]',
    calibration_status TEXT NOT NULL DEFAULT 'pending',
    coverage_percent INTEGER NOT NULL DEFAULT 0,
    use_case_category TEXT NOT NULL DEFAULT '默认',
    variant_category TEXT NOT NULL DEFAULT '基准',
    version_label TEXT NOT NULL DEFAULT '',
    firmware_file_id TEXT,
    firmware_source TEXT NOT NULL DEFAULT '',
    firmware_build_key TEXT NOT NULL DEFAULT '',
    firmware_build_time INTEGER,
    consistency_json TEXT NOT NULL DEFAULT '{}',
    published INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL DEFAULT 'coach',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS fleet_firmware_files (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    board_identifier TEXT NOT NULL DEFAULT '',
    firmware_version TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    hex_content BLOB NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'local',
    build_key TEXT NOT NULL DEFAULT '',
    build_time INTEGER,
    uploaded_by TEXT NOT NULL DEFAULT 'coach',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fleet_firmware_updated
    ON fleet_firmware_files(updated_at DESC);

  CREATE TABLE IF NOT EXISTS fleet_tuning_sessions (
    id TEXT PRIMARY KEY,
    aircraft_id TEXT,
    flight_controller_id TEXT,
    operator_role TEXT NOT NULL DEFAULT 'guest',
    operator_label TEXT NOT NULL DEFAULT '',
    purpose TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    firmware_version TEXT NOT NULL DEFAULT '',
    upload_token_hash TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fleet_sessions_aircraft_time
    ON fleet_tuning_sessions(aircraft_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_fleet_sessions_controller_time
    ON fleet_tuning_sessions(flight_controller_id, started_at DESC);

  CREATE TABLE IF NOT EXISTS fleet_configuration_snapshots (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    snapshot_type TEXT NOT NULL,
    sequence_number INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL,
    content_format TEXT NOT NULL DEFAULT 'betaflight_cli',
    content_hash TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fleet_snapshots_session_sequence
    ON fleet_configuration_snapshots(session_id, sequence_number, created_at);

  CREATE TABLE IF NOT EXISTS fleet_tuning_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    sequence_number INTEGER NOT NULL DEFAULT 0,
    event_type TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '',
    msp_code INTEGER,
    msp_name TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}',
    committed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fleet_events_session_sequence
    ON fleet_tuning_events(session_id, sequence_number, created_at);

  CREATE TABLE IF NOT EXISTS fleet_aircraft_states (
    id TEXT PRIMARY KEY,
    aircraft_id TEXT,
    flight_controller_id TEXT NOT NULL,
    previous_state_id TEXT,
    operator_role TEXT NOT NULL DEFAULT 'guest',
    operator_label TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'connection_scan',
    board_identifier TEXT NOT NULL DEFAULT '',
    firmware_version TEXT NOT NULL DEFAULT '',
    api_version TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL,
    content_format TEXT NOT NULL DEFAULT 'json',
    content_hash TEXT NOT NULL,
    changed_domains_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fleet_states_aircraft_time
    ON fleet_aircraft_states(aircraft_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_fleet_states_controller_time
    ON fleet_aircraft_states(flight_controller_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS fleet_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_role TEXT NOT NULL,
    actor_label TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL DEFAULT '',
    detail_json TEXT NOT NULL DEFAULT '{}',
    ip_address TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_fleet_audit_time
    ON fleet_audit_log(created_at DESC);

  CREATE TABLE IF NOT EXISTS fleet_error_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    stage TEXT NOT NULL,
    message TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS fleet_ground_station_settings (
    setting_key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
`);

const aircraftTableSql = String(
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fleet_aircraft'").get()?.sql || "",
);
if (/serial_number\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(aircraftTableSql)) {
  db.exec("DROP INDEX IF EXISTS idx_fleet_aircraft_owner_serial");
  db.exec("BEGIN");
  try {
    db.exec(`
      ALTER TABLE fleet_aircraft RENAME TO fleet_aircraft_legacy_unique;
      CREATE TABLE fleet_aircraft (
        id TEXT PRIMARY KEY,
        serial_number TEXT NOT NULL,
        owner_pilot_id TEXT,
        model TEXT NOT NULL DEFAULT '',
        configuration_note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO fleet_aircraft
        (id, serial_number, owner_pilot_id, model, configuration_note, status, created_at, updated_at)
      SELECT id, serial_number, owner_pilot_id, model, configuration_note, status, created_at, updated_at
      FROM fleet_aircraft_legacy_unique;
      DROP TABLE fleet_aircraft_legacy_unique;
      CREATE UNIQUE INDEX idx_fleet_aircraft_owner_serial
        ON fleet_aircraft(COALESCE(owner_pilot_id, ''), serial_number)
        WHERE status = 'active';
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

const presetColumns = db.prepare("PRAGMA table_info(fleet_configuration_presets)").all();
if (!presetColumns.some((column) => column.name === "board_identifier")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN board_identifier TEXT NOT NULL DEFAULT ''");
}
if (!presetColumns.some((column) => column.name === "pilot_id")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN pilot_id TEXT");
}
if (!presetColumns.some((column) => column.name === "parent_preset_id")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN parent_preset_id TEXT");
}
if (!presetColumns.some((column) => column.name === "version_number")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN version_number INTEGER NOT NULL DEFAULT 1");
}
if (!presetColumns.some((column) => column.name === "raw_cli_text")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN raw_cli_text TEXT NOT NULL DEFAULT ''");
}
if (!presetColumns.some((column) => column.name === "canonical_snapshot")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN canonical_snapshot TEXT NOT NULL DEFAULT ''");
}
if (!presetColumns.some((column) => column.name === "mapping_version")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN mapping_version INTEGER NOT NULL DEFAULT 1");
}
if (!presetColumns.some((column) => column.name === "unmapped_cli_json")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN unmapped_cli_json TEXT NOT NULL DEFAULT '[]'");
}
if (!presetColumns.some((column) => column.name === "calibration_status")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN calibration_status TEXT NOT NULL DEFAULT 'pending'");
}
if (!presetColumns.some((column) => column.name === "coverage_percent")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN coverage_percent INTEGER NOT NULL DEFAULT 0");
}
if (!presetColumns.some((column) => column.name === "use_case_category")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN use_case_category TEXT NOT NULL DEFAULT '默认'");
}
if (!presetColumns.some((column) => column.name === "variant_category")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN variant_category TEXT NOT NULL DEFAULT '基准'");
}
if (!presetColumns.some((column) => column.name === "version_label")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN version_label TEXT NOT NULL DEFAULT ''");
}
if (!presetColumns.some((column) => column.name === "firmware_file_id")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN firmware_file_id TEXT");
}
if (!presetColumns.some((column) => column.name === "firmware_source")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN firmware_source TEXT NOT NULL DEFAULT ''");
}
if (!presetColumns.some((column) => column.name === "firmware_build_key")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN firmware_build_key TEXT NOT NULL DEFAULT ''");
}
if (!presetColumns.some((column) => column.name === "firmware_build_time")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN firmware_build_time INTEGER");
}
if (!presetColumns.some((column) => column.name === "consistency_json")) {
  db.exec("ALTER TABLE fleet_configuration_presets ADD COLUMN consistency_json TEXT NOT NULL DEFAULT '{}'");
}

const firmwareColumns = db.prepare("PRAGMA table_info(fleet_firmware_files)").all();
if (!firmwareColumns.some((column) => column.name === "source_type")) {
  db.exec("ALTER TABLE fleet_firmware_files ADD COLUMN source_type TEXT NOT NULL DEFAULT 'local'");
}
if (!firmwareColumns.some((column) => column.name === "build_key")) {
  db.exec("ALTER TABLE fleet_firmware_files ADD COLUMN build_key TEXT NOT NULL DEFAULT ''");
}
if (!firmwareColumns.some((column) => column.name === "build_time")) {
  db.exec("ALTER TABLE fleet_firmware_files ADD COLUMN build_time INTEGER");
}

const controllerColumns = db.prepare("PRAGMA table_info(fleet_flight_controllers)").all();
if (!controllerColumns.some((column) => column.name === "build_key")) {
  db.exec("ALTER TABLE fleet_flight_controllers ADD COLUMN build_key TEXT NOT NULL DEFAULT ''");
}
db.exec(`
  UPDATE fleet_configuration_presets
  SET raw_cli_text = content
  WHERE content_format = 'betaflight_cli' AND raw_cli_text = '';
  UPDATE fleet_configuration_presets
  SET canonical_snapshot = content,
      calibration_status = 'calibrated',
      coverage_percent = CASE WHEN coverage_percent = 0 THEN 100 ELSE coverage_percent END
  WHERE content_format = 'json' AND canonical_snapshot = '';
`);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_fleet_presets_version_catalog
  ON fleet_configuration_presets(
    board_identifier,
    firmware_version,
    kind,
    COALESCE(pilot_id, ''),
    version_number DESC
  )
`);

// Older Agent builds stored the short hardware identifier (for example H743)
// in board_identifier and the firmware target after "/" in board_name. The
// fleet now uses that target consistently for display and matching.
db.exec(`
  UPDATE fleet_flight_controllers
  SET board_identifier = board_name
  WHERE TRIM(board_name) <> ''
    AND board_identifier <> board_name
`);
}
