export const CONFIGURATION_MAPPING_VERSION = 7;

const CATEGORY_LABELS = Object.freeze({
  identity: "名称",
  pid: "PID",
  rates: "Rate",
  filters: "滤波",
  motor: "电机",
  receiver: "接收机",
  failsafe: "失控保护",
  vtx: "图传",
  battery: "电池",
  ports: "端口",
  modes: "模式",
  osd: "OSD",
  gps: "GPS",
  led: "LED",
  sensors: "传感器",
  blackbox: "黑匣子",
  servos: "舵机",
  features: "功能",
  advanced: "高级硬件",
  legacy: "旧版设置",
  other: "其他",
});

const AXIS_LABELS = Object.freeze({
  roll: "横滚",
  pitch: "俯仰",
  yaw: "偏航",
});

const TERM_LABELS = Object.freeze({
  p: "P",
  i: "I",
  d: "D",
  f: "F",
  rcRate: "RC Rate",
  expo: "Expo",
  superRate: "Super Rate",
  limit: "转速限制",
});

const FLIGHT_MODE_LABELS = Object.freeze({
  ARM: "解锁",
  ANGLE: "自稳",
  HORIZON: "地平线",
  ALTHOLD: "定高",
  POSHOLD: "定点",
  MAG: "航向保持",
  HEADFREE: "无头模式",
  HEADADJ: "航向重置",
  PASSTHRU: "直通",
  FAILSAFE: "失控保护",
  "GPS RESCUE": "GPS 救援",
  GPS_RESCUE: "GPS 救援",
  BEEPER: "蜂鸣器",
  BLACKBOX: "黑匣子",
  "AIR MODE": "空中模式",
  AIRMODE: "空中模式",
  "FLIP OVER AFTER CRASH": "反乌龟",
  FLIP_OVER_AFTER_CRASH: "反乌龟",
  PREARM: "预解锁",
  "PRE ARM": "预解锁",
  PARALYZE: "锁定",
  LAUNCH_CONTROL: "起飞控制",
  "LAUNCH CONTROL": "起飞控制",
  "ACRO TRAINER": "特技训练",
  ACRO_TRAINER: "特技训练",
  "VTX PIT MODE": "图传 Pit 模式",
  VTX_PIT_MODE: "图传 Pit 模式",
  "LAP TIMER RESET": "圈计时重置",
  LAP_TIMER_RESET: "圈计时重置",
  USER1: "用户模式 1",
  USER2: "用户模式 2",
  USER3: "用户模式 3",
  USER4: "用户模式 4",
  CAMSTAB: "云台增稳",
  CAMERA1: "相机控制 1",
  CAMERA2: "相机控制 2",
  CAMERA3: "相机控制 3",
  OSD: "OSD",
  TELEMETRY: "遥测",
  LEDLOW: "LED 低亮度",
  CALIB: "校准",
});

const FEATURE_BIT_LABELS = Object.freeze({
  0: "PPM 接收机",
  2: "飞行中加速度计校准",
  3: "串行接收机",
  4: "电机停止",
  5: "舵机云台",
  6: "软串口",
  7: "GPS",
  10: "遥测",
  12: "3D 模式",
  13: "并行 PWM 接收机",
  14: "MSP 接收机",
  15: "模拟 RSSI",
  16: "LED 灯带",
  17: "显示屏",
  18: "OSD",
  20: "通道转发",
  22: "空中模式",
  25: "SPI 接收机",
  27: "电调传感器",
  28: "反重力",
});

function flightModeLabel(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return FLIGHT_MODE_LABELS[normalized] || normalized.replaceAll("_", " ") || "未知模式";
}

const EXACT_CLI_SETTINGS = Object.freeze({
  craftname: { canonicalPath: "device.craftName", category: "identity", label: "飞行器名称", valueType: "text" },
  craft_name: { canonicalPath: "device.craftName", category: "identity", label: "飞行器名称", valueType: "text" },
  name: { canonicalPath: "device.craftName", category: "identity", label: "飞行器名称", valueType: "text" },
  pilotname: { canonicalPath: "device.pilotName", category: "identity", label: "飞手名称", valueType: "text" },
  pilot_name: { canonicalPath: "device.pilotName", category: "identity", label: "飞手名称", valueType: "text" },
  vtx_band: { canonicalPath: "settings.vtx.band", category: "vtx", label: "图传频段", valueType: "vtxBand" },
  vtxband: { canonicalPath: "settings.vtx.band", category: "vtx", label: "图传频段", valueType: "vtxBand" },
  vtx_channel: { canonicalPath: "settings.vtx.channel", category: "vtx", label: "图传频道", valueType: "vtxChannel" },
  vtxchannel: { canonicalPath: "settings.vtx.channel", category: "vtx", label: "图传频道", valueType: "vtxChannel" },
  vtx_power: { canonicalPath: "settings.vtx.power", category: "vtx", label: "图传功率档位", valueType: "plain" },
  vtx_pit_mode_freq: { canonicalPath: "settings.vtx.pitModeFrequency", category: "vtx", label: "Pit 模式频率", valueType: "mhz" },
  vtx_low_power_disarm: { canonicalPath: "settings.vtx.lowPowerDisarm", category: "vtx", label: "未解锁低功率", valueType: "boolean" },
  motor_direction: { canonicalPath: "settings.motor.direction", category: "motor", label: "电机转向", valueType: "motorDirection" },
  motor_direction_reversed: { canonicalPath: "settings.motor.direction", category: "motor", label: "电机转向", valueType: "motorDirection" },
  reverse_motor_dir: { canonicalPath: "settings.motor.direction", category: "motor", label: "电机转向", valueType: "motorDirection" },
  dshot_bidir: { canonicalPath: "settings.motor.bidirectionalDshot", category: "motor", label: "双向 DShot", valueType: "boolean" },
  motor_pwm_protocol: { canonicalPath: "settings.motor.protocol", category: "motor", label: "电机协议", valueType: "motorProtocol" },
  motor_pwm_rate: { canonicalPath: "settings.motor.pwmRate", category: "motor", label: "电机 PWM 频率", valueType: "hz" },
  fast_pwm_protocol: { canonicalPath: "settings.systemAdvanced.motorProtocol", category: "motor", label: "电机协议", valueType: "motorProtocol" },
  motor_protocol: { canonicalPath: "settings.systemAdvanced.motorProtocol", category: "motor", label: "电机协议", valueType: "motorProtocol" },
  digital_idle_percent: { canonicalPath: "settings.systemAdvanced.dshotIdle", category: "motor", label: "DShot 怠速", valueType: "percent" },
  dshot_idle_percent: { canonicalPath: "settings.systemAdvanced.dshotIdle", category: "motor", label: "DShot 怠速", valueType: "percent" },
  gyro_sync_denom: { canonicalPath: "settings.systemAdvanced.gyroLoopDivider", category: "sensors", label: "陀螺仪循环分频", valueType: "plain" },
  gyro_loop_divider: { canonicalPath: "settings.systemAdvanced.gyroLoopDivider", category: "sensors", label: "陀螺仪循环分频", valueType: "plain" },
  pid_process_denom: { canonicalPath: "settings.systemAdvanced.pidLoopDivider", category: "pid", label: "PID 循环分频", valueType: "plain" },
  pid_loop_divider: { canonicalPath: "settings.systemAdvanced.pidLoopDivider", category: "pid", label: "PID 循环分频", valueType: "plain" },
  use_unsynced_pwm: { canonicalPath: "settings.systemAdvanced.unsyncedPwm", category: "motor", label: "非同步 PWM", valueType: "boolean" },
  unsynced_pwm: { canonicalPath: "settings.systemAdvanced.unsyncedPwm", category: "motor", label: "非同步 PWM", valueType: "boolean" },
  motor_pwm_inversion: { canonicalPath: "settings.systemAdvanced.pwmInversion", category: "motor", label: "电机 PWM 反相", valueType: "boolean" },
  gyro_high_fsr: { canonicalPath: "settings.systemAdvanced.gyroHighFsr", category: "sensors", label: "陀螺仪高量程", valueType: "boolean" },
  gyro_movement_calib_threshold: { canonicalPath: "settings.systemAdvanced.gyroCalibrationThreshold", category: "sensors", label: "陀螺仪校准静止阈值", valueType: "plain" },
  gyro_movement_calibration_threshold: { canonicalPath: "settings.systemAdvanced.gyroCalibrationThreshold", category: "sensors", label: "陀螺仪校准静止阈值", valueType: "plain" },
  gyro_calib_duration: { canonicalPath: "settings.systemAdvanced.gyroCalibrationDuration", category: "sensors", label: "陀螺仪校准时长", valueType: "plain" },
  gyro_calibration_duration: { canonicalPath: "settings.systemAdvanced.gyroCalibrationDuration", category: "sensors", label: "陀螺仪校准时长", valueType: "plain" },
  gyro_offset_yaw: { canonicalPath: "settings.systemAdvanced.gyroYawOffset", category: "sensors", label: "陀螺仪偏航校正", valueType: "plain" },
  gyro_yaw_offset: { canonicalPath: "settings.systemAdvanced.gyroYawOffset", category: "sensors", label: "陀螺仪偏航校正", valueType: "plain" },
  gyro_check_overflow: { canonicalPath: "settings.systemAdvanced.gyroOverflowCheck", category: "sensors", label: "陀螺仪溢出检查", valueType: "plain" },
  gyro_overflow_check: { canonicalPath: "settings.systemAdvanced.gyroOverflowCheck", category: "sensors", label: "陀螺仪溢出检查", valueType: "plain" },
  gyro_use32k_hz: { canonicalPath: "settings.systemAdvanced.gyro32kHz", category: "sensors", label: "陀螺仪 32kHz", valueType: "boolean" },
  gyro32k_hz: { canonicalPath: "settings.systemAdvanced.gyro32kHz", category: "sensors", label: "陀螺仪 32kHz", valueType: "boolean" },
  debug_mode: { canonicalPath: "settings.systemAdvanced.debugMode", category: "blackbox", label: "调试模式", valueType: "plain" },
  motor_idle: { canonicalPath: "settings.motor.idle", category: "motor", label: "电机怠速", valueType: "percent" },
  dshot_idle_value: { canonicalPath: "settings.motor.dshotIdle", category: "motor", label: "DShot 怠速", valueType: "plain" },
  throttle_limit_type: { canonicalPath: "profiles.rates.throttle.limitType", category: "rates", label: "油门限制方式", valueType: "throttleLimitType" },
  throttlelimit_type: { canonicalPath: "profiles.rates.throttle.limitType", category: "rates", label: "油门限制方式", valueType: "throttleLimitType" },
  throttle_limit_percent: { canonicalPath: "profiles.rates.throttle.limitPercent", category: "rates", label: "油门限制", valueType: "percent" },
  throttlelimit_percent: { canonicalPath: "profiles.rates.throttle.limitPercent", category: "rates", label: "油门限制", valueType: "percent" },
  rates_type: { canonicalPath: "profiles.rates.ratesType", category: "rates", label: "Rate 类型", valueType: "ratesType" },
  report_cell_voltage: { canonicalPath: "settings.battery.reportCellVoltage", category: "battery", label: "回传单芯电压", valueType: "boolean" },
  serialrx_provider: { canonicalPath: "settings.receiver.serialProvider", category: "receiver", label: "串行接收机协议", valueType: "plain" },
  serialrx_inverted: { canonicalPath: "settings.receiver.serialInverted", category: "receiver", label: "接收机信号反相", valueType: "boolean" },
  serialrx_halfduplex: { canonicalPath: "settings.receiver.serialHalfDuplex", category: "receiver", label: "接收机半双工", valueType: "boolean" },
  failsafe_procedure: { canonicalPath: "settings.failsafe.procedure", category: "failsafe", label: "失控保护动作", valueType: "failsafeProcedure" },
  failsafe_delay: { canonicalPath: "settings.failsafe.delay", category: "failsafe", label: "失控保护延迟", valueType: "deciseconds" },
  blackbox_device: { canonicalPath: "settings.blackbox.device", category: "blackbox", label: "黑匣子存储设备", valueType: "plain" },
});

const WORD_LABELS = Object.freeze({
  acc: "加速度计",
  adjustment: "调整",
  advanced: "高级",
  alignment: "方向",
  anti: "防",
  arming: "解锁",
  auto: "自动",
  band: "频段",
  battery: "电池",
  beeper: "蜂鸣器",
  bidirectional: "双向",
  blackbox: "黑匣子",
  boost: "增强",
  channel: "频道",
  compass: "罗盘",
  current: "电流",
  cutoff: "截止频率",
  deadband: "死区",
  dshot: "DShot",
  dynamic: "动态",
  expo: "Expo",
  failsafe: "失控保护",
  feedforward: "前馈",
  filter: "滤波",
  frequency: "频率",
  gps: "GPS",
  gyro: "陀螺仪",
  idle: "怠速",
  limit: "限制",
  lowpass: "低通",
  max: "最大",
  min: "最小",
  mixer: "混控",
  mode: "模式",
  motor: "电机",
  notch: "陷波",
  osd: "OSD",
  output: "输出",
  pilot: "飞手",
  power: "功率",
  protocol: "协议",
  pwm: "PWM",
  rc: "RC",
  rate: "Rate",
  receiver: "接收机",
  rescue: "救援",
  roll: "横滚",
  pitch: "俯仰",
  yaw: "偏航",
  rpm: "RPM",
  rssi: "RSSI",
  sensor: "传感器",
  serial: "串口",
  smoothing: "平滑",
  throttle: "油门",
  vtx: "图传",
  voltage: "电压",
  lpf: "低通",
  active: "启用",
  altitude: "高度",
  angle: "角度",
  averaging: "平均",
  baud: "波特率",
  beacon: "信标",
  breakpoint: "起效点",
  capacity: "容量",
  cell: "单芯",
  center: "中点",
  compensation: "补偿",
  count: "数量",
  curve: "曲线",
  delay: "延迟",
  denom: "分频",
  derivative: "微分",
  device: "设备",
  disabled: "禁用",
  distance: "距离",
  enabled: "启用",
  flags: "标志",
  hardware: "硬件",
  harmonics: "谐波",
  hover: "悬停",
  input: "输入",
  integrated: "积分",
  interpolation: "插值",
  iterm: "I 项",
  jitter: "抖动",
  level: "自稳",
  mask: "掩码",
  midpoint: "中点",
  name: "名称",
  neutral: "中立点",
  offset: "偏移",
  once: "一次",
  poles: "磁极数",
  position: "位置",
  procedure: "动作",
  provider: "协议",
  quality: "质量",
  reduction: "衰减",
  reversed: "反向",
  source: "来源",
  speed: "速度",
  start: "起点",
  stick: "摇杆",
  switch: "开关",
  threshold: "阈值",
  transition: "过渡",
  type: "类型",
  uid: "UID",
  unit: "单位",
  use: "使用",
  value: "值",
  warning: "警告",
  width: "宽度",
});

function profileDescription(scopeType, zeroBasedIndex) {
  const index = Number(zeroBasedIndex);
  if (!Number.isInteger(index)) return {};
  return {
    profileType: scopeType === "rateprofile" ? "rate" : "pid",
    profileIndex: index,
    profileLabel: `${scopeType === "rateprofile" ? "Rate" : "PID"} Profile ${index + 1}`,
  };
}

function wordsFromIdentifier(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function humanizeIdentifier(value) {
  const words = wordsFromIdentifier(value);
  if (!words.length) return String(value || "");
  return words.map((word) => WORD_LABELS[word.toLowerCase()] || word.toUpperCase()).join(" ");
}

function categoryFromMspPath(path) {
  if (path.startsWith("device.")) return "identity";
  if (path.startsWith("profiles.pid")) {
    return /\.filters(?:\.|$)/.test(path) ? "filters" : "pid";
  }
  if (path.startsWith("profiles.rates")) return "rates";
  const domain = path.match(/^settings\.([^.[]+)/)?.[1] || "";
  const categories = {
    mixer: "motor",
    systemAdvanced: "motor",
    motor: "motor",
    motor3d: "motor",
    motorOutputOrder: "motor",
    receiver: "receiver",
    receiverMap: "receiver",
    receiverDeadband: "receiver",
    receiverFailsafe: "failsafe",
    failsafe: "failsafe",
    arming: "failsafe",
    features: "features",
    beeper: "features",
    vtx: "vtx",
    vtxTableBands: "vtx",
    vtxTablePowerLevels: "vtx",
    battery: "battery",
    voltageMeters: "battery",
    currentMeters: "battery",
    ports: "ports",
    modes: "modes",
    modeRangesExtra: "modes",
    adjustments: "modes",
    osd: "osd",
    gps: "gps",
    gpsRescue: "gps",
    ledColors: "led",
    ledStrip: "led",
    ledModeColors: "led",
    boardAlignment: "sensors",
    accelerometerTrims: "sensors",
    sensorAlignment: "sensors",
    sensors: "sensors",
    compass: "sensors",
    blackbox: "blackbox",
    servos: "servos",
    servoRules: "servos",
    legacyCore: "legacy",
    legacyMisc: "legacy",
    transponder: "advanced",
  };
  return categories[domain] || "other";
}

function valueTypeFromName(value) {
  const name = String(value || "").toLowerCase();
  if (/(frequency|_hz$|static_hz|cutoff)/.test(name)) return "hz";
  if (/(percent|percentage)/.test(name)) return "percent";
  if (/(enabled|enable|inverted|halfduplex|bidir|report_cell_voltage)/.test(name)) return "boolean";
  return "plain";
}

const EXACT_MSP_PATHS = Object.freeze({
  "settings.mixer.reverseMotorDir": {
    category: "motor",
    label: "电机转向",
    valueType: "motorDirection",
  },
  "settings.systemAdvanced.motorProtocol": {
    category: "motor",
    label: "电机协议",
    valueType: "motorProtocol",
  },
  "settings.systemAdvanced.unsyncedPwm": {
    category: "motor",
    label: "非同步 PWM",
    valueType: "boolean",
  },
  "settings.systemAdvanced.motorPwmInversion": {
    category: "motor",
    label: "电机 PWM 反相",
    valueType: "boolean",
  },
  "settings.motor.bidirectionalDshot": {
    category: "motor",
    label: "双向 DShot",
    valueType: "boolean",
  },
  "settings.receiver.serialProvider": {
    category: "receiver",
    label: "串行接收机协议",
    valueType: "plain",
  },
  "settings.receiver.serialInverted": {
    category: "receiver",
    label: "接收机信号反相",
    valueType: "boolean",
  },
  "settings.receiver.serialHalfDuplex": {
    category: "receiver",
    label: "接收机半双工",
    valueType: "boolean",
  },
  "settings.failsafe.procedure": {
    category: "failsafe",
    label: "失控保护动作",
    valueType: "failsafeProcedure",
  },
  "settings.battery.reportCellVoltage": {
    category: "battery",
    label: "回传单芯电压",
    valueType: "boolean",
  },
  "settings.vtx.band": {
    category: "vtx",
    label: "图传频段",
    valueType: "vtxBand",
  },
  "settings.vtx.channel": {
    category: "vtx",
    label: "图传频道",
    valueType: "vtxChannel",
  },
});

function describeMspPath(key) {
  const device = key.match(/^device\.(craftName|pilotName)$/);
  if (device) {
    return {
      canonicalPath: key,
      category: "identity",
      label: device[1] === "craftName" ? "飞行器名称" : "飞手名称",
      valueType: "text",
      mapped: true,
    };
  }

  const pidAxis = key.match(/^profiles\.pid\[(\d+)]\.axes\.(roll|pitch|yaw)\.(p|i|d|f)$/);
  if (pidAxis) {
    return {
      canonicalPath: key,
      category: "pid",
      label: `${AXIS_LABELS[pidAxis[2]]} ${TERM_LABELS[pidAxis[3]]}`,
      valueType: "plain",
      mapped: true,
      tableKind: "pid",
      ...profileDescription("profile", pidAxis[1]),
    };
  }

  const rateAxis = key.match(/^profiles\.rates\[(\d+)]\.axes\.(roll|pitch|yaw)\.(rcRate|expo|superRate|limit)$/);
  if (rateAxis) {
    return {
      canonicalPath: key,
      category: "rates",
      label: `${AXIS_LABELS[rateAxis[2]]} ${TERM_LABELS[rateAxis[3]]}`,
      valueType: rateAxis[3] === "limit" ? "degreesPerSecond" : "plain",
      mapped: true,
      tableKind: "rates",
      ...profileDescription("rateprofile", rateAxis[1]),
    };
  }

  const throttle = key.match(/^profiles\.rates\[(\d+)]\.throttle\.(midpoint|expo|limitType|limitPercent)$/);
  if (throttle) {
    const labels = {
      midpoint: "油门中点",
      expo: "油门 Expo",
      limitType: "油门限制方式",
      limitPercent: "油门限制",
    };
    return {
      canonicalPath: key,
      category: "rates",
      label: labels[throttle[2]],
      valueType: throttle[2] === "limitPercent"
        ? "percent"
        : throttle[2] === "limitType" ? "throttleLimitType" : "plain",
      mapped: true,
      tableKind: "rates",
      ...profileDescription("rateprofile", throttle[1]),
    };
  }

  const ratesType = key.match(/^profiles\.rates\[(\d+)]\.ratesType$/);
  if (ratesType) {
    return {
      canonicalPath: key,
      category: "rates",
      label: "Rate 类型",
      valueType: "ratesType",
      mapped: true,
      tableKind: "rates",
      ...profileDescription("rateprofile", ratesType[1]),
    };
  }

  const legacyRateEnum = key.match(
    /^profiles\.rates\[(\d+)]\.(?:throttle\.)?(thrlimtype|throttleLimitType|ratetype|rateType)$/,
  );
  if (legacyRateEnum) {
    const isLimitType = /thrlim|throttle/i.test(legacyRateEnum[2]);
    return {
      canonicalPath: key,
      category: "rates",
      label: isLimitType ? "油门限制方式" : "Rate 类型",
      valueType: isLimitType ? "throttleLimitType" : "ratesType",
      mapped: true,
      tableKind: "rates",
      ...profileDescription("rateprofile", legacyRateEnum[1]),
    };
  }

  const modeRange = key.match(/^settings\.modes\.(.+?)\[(\d+)]\.(auxChannel|start|end|logic|linkedTo)$/);
  if (modeRange) {
    const fieldLabels = {
      auxChannel: "开关通道",
      start: "触发范围起点",
      end: "触发范围终点",
      logic: "组合逻辑",
      linkedTo: "关联模式",
    };
    return {
      canonicalPath: key,
      category: "modes",
      label: `${flightModeLabel(modeRange[1])} · 范围 ${Number(modeRange[2]) + 1} · ${fieldLabels[modeRange[3]]}`,
      valueType: modeRange[3] === "linkedTo" ? "flightMode" : "plain",
      mapped: true,
    };
  }

  if (key === "settings.features.features._featureMask") {
    return {
      canonicalPath: key,
      category: "features",
      label: "功能开关",
      valueType: "featureMask",
      mapped: true,
    };
  }

  const osdItem = key.match(
    /^settings\.osd\.(displayItems|statistics|warnings|timers)\[(.+?)]\.(position|visible|variant|enabled|source|precision|alarm)$/,
  );
  if (osdItem) {
    const groupLabels = {
      displayItems: "显示项目",
      statistics: "统计项目",
      warnings: "警告项目",
      timers: "计时器",
    };
    const fieldLabels = {
      position: "位置",
      visible: "显示",
      variant: "样式",
      enabled: "启用",
      source: "来源",
      precision: "精度",
      alarm: "警报值",
    };
    return {
      canonicalPath: key,
      category: "osd",
      label: `${groupLabels[osdItem[1]]} ${humanizeIdentifier(osdItem[2])} · ${fieldLabels[osdItem[3]]}`,
      valueType: ["visible", "enabled"].includes(osdItem[3]) ? "boolean" : "plain",
      mapped: true,
    };
  }

  const profileProperty = key.match(/^profiles\.(pid|rates)\[(\d+)]\.(advanced|tuning|filters|deadband|raw)\.(.+)$/);
  if (profileProperty) {
    const profileType = profileProperty[1] === "rates" ? "rateprofile" : "profile";
    const category = profileProperty[3] === "filters" ? "filters" : profileProperty[1];
    const leaf = profileProperty[4].split(".").at(-1) || profileProperty[4];
    const normalizedLeaf = leaf
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase();
    const exact = EXACT_CLI_SETTINGS[normalizedLeaf];
    return {
      canonicalPath: key,
      category: exact?.category || category,
      label: exact?.label || humanizeIdentifier(profileProperty[4]),
      valueType: exact?.valueType || valueTypeFromName(profileProperty[4]),
      mapped: true,
      ...profileDescription(profileType, profileProperty[2]),
    };
  }

  const exactPath = EXACT_MSP_PATHS[key];
  if (exactPath) {
    return {
      ...exactPath,
      canonicalPath: key,
      mapped: true,
    };
  }

  const category = categoryFromMspPath(key);
  const leaf = key.split(".").at(-1) || key;
  const normalizedLeaf = leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  const exactLeaf = EXACT_CLI_SETTINGS[normalizedLeaf];
  if (exactLeaf) {
    return {
      ...exactLeaf,
      canonicalPath: key,
      mapped: true,
    };
  }
  const indexedLeaf = key.match(/(?:^|\.)([^.[\]]+)\[(\d+)](?:\.([^.[\]]+))?$/);
  const indexedLabel = indexedLeaf
    ? `${humanizeIdentifier(indexedLeaf[1])} · 第 ${Number(indexedLeaf[2]) + 1} 项${indexedLeaf[3] ? ` · ${humanizeIdentifier(indexedLeaf[3])}` : ""}`
    : humanizeIdentifier(leaf);
  return {
    canonicalPath: key,
    category,
    label: indexedLabel,
    valueType: valueTypeFromName(leaf),
    // JSON snapshots are produced only after the official Betaflight MSP
    // decoder has interpreted the version-specific byte layout. Even when a
    // field does not yet have a hand-written Chinese label, its canonical path
    // is stable and meaningful; do not incorrectly present it as "未映射".
    mapped: true,
  };
}

function settingPattern(settingName, scope) {
  const pidTermPrefix = settingName.match(/^(p|i|d|f)_(roll|pitch|yaw)$/i);
  const pidTermSuffix = settingName.match(/^(roll|pitch|yaw)_(p|i|d|f)$/i);
  if (pidTermPrefix || pidTermSuffix) {
    const term = (pidTermPrefix ? pidTermPrefix[1] : pidTermSuffix[2]).toLowerCase();
    const axis = (pidTermPrefix ? pidTermPrefix[2] : pidTermSuffix[1]).toLowerCase();
    return {
      canonicalPath: `profiles.pid[${scope.profileIndex ?? 0}].axes.${axis}.${term}`,
      category: "pid",
      label: `${AXIS_LABELS[axis]} ${TERM_LABELS[term]}`,
      valueType: "plain",
      mapped: true,
    };
  }

  const rate = settingName.match(/^(roll|pitch|yaw)_(rc_rate|expo|srate|rate|rate_limit)$/i);
  if (rate) {
    const property = {
      rc_rate: "rcRate",
      expo: "expo",
      srate: "superRate",
      rate: "superRate",
      rate_limit: "limit",
    }[rate[2].toLowerCase()];
    return {
      canonicalPath: `profiles.rates[${scope.profileIndex ?? 0}].axes.${rate[1].toLowerCase()}.${property}`,
      category: "rates",
      label: `${AXIS_LABELS[rate[1].toLowerCase()]} ${TERM_LABELS[property]}`,
      valueType: property === "limit" ? "degreesPerSecond" : "plain",
      mapped: true,
    };
  }

  if (/^(gyro|dterm|dyn_notch|rpm_filter|yaw_lowpass|iterm_relax|feedforward)/i.test(settingName)) {
    const category = /^(gyro|dterm|dyn_notch|rpm_filter|yaw_lowpass)/i.test(settingName)
      ? "filters"
      : "pid";
    return {
      canonicalPath: `profiles.pid[${scope.profileIndex ?? 0}].${category}.${settingName}`,
      category,
      label: humanizeIdentifier(settingName),
      valueType: valueTypeFromName(settingName),
      mapped: true,
    };
  }
  return null;
}

function describeCliKey(key) {
  const scoped = key.match(/^(profile|rateprofile)\s+(\d+)\s+·\s+(.+)$/i);
  const scope = scoped ? profileDescription(scoped[1].toLowerCase(), scoped[2]) : {};
  const commandText = scoped ? scoped[3] : key;
  const setting = commandText.match(/^set\s+(.+)$/i);
  if (setting) {
    const settingName = setting[1].trim().toLowerCase();
    const exact = EXACT_CLI_SETTINGS[settingName];
    const patterned = settingPattern(settingName, scope);
    const descriptor = patterned || exact;
    if (descriptor) return { mapped: true, ...descriptor, ...scope };
    const category = /^(osd_|displayport_)/.test(settingName)
      ? "osd"
      : /^(rx_|rc_|serialrx_)/.test(settingName)
        ? "receiver"
        : /^(vbat_|ibat_|battery_|current_meter|voltage_meter)/.test(settingName)
          ? "battery"
          : /^(failsafe_)/.test(settingName)
            ? "failsafe"
            : "other";
    return {
      canonicalPath: `cli.settings.${settingName}`,
      category,
      label: humanizeIdentifier(settingName),
      valueType: valueTypeFromName(settingName),
      mapped: false,
      ...scope,
    };
  }

  const command = commandText.match(/^([a-z_]+)\s*(.*)$/i);
  const name = command?.[1]?.toLowerCase() || "";
  const identity = command?.[2]?.trim() || "";
  const commandDescriptors = {
    feature: { category: "features", label: `功能 ${humanizeIdentifier(identity.replace(/^-/, ""))}`, valueType: "commandToggle" },
    beeper: { category: "features", label: `蜂鸣器 ${humanizeIdentifier(identity.replace(/^-/, ""))}`, valueType: "commandToggle" },
    map: { category: "receiver", label: "遥控通道映射", valueType: "plain" },
    mixer: { category: "motor", label: `机架混控 ${identity}`, valueType: "plain" },
    serial: { category: "ports", label: `串口 ${identity}`, valueType: "plain" },
    aux: { category: "modes", label: `模式范围 ${identity}`, valueType: "plain" },
    adjrange: { category: "modes", label: `调整范围 ${identity}`, valueType: "plain" },
    rxrange: { category: "receiver", label: `接收机通道范围 ${identity}`, valueType: "plain" },
    rxfail: { category: "failsafe", label: `通道失控保护 ${identity}`, valueType: "plain" },
    resource: { category: "advanced", label: `资源分配 ${identity}`, valueType: "plain" },
    timer: { category: "advanced", label: `定时器 ${identity}`, valueType: "plain" },
    dma: { category: "advanced", label: `DMA ${identity}`, valueType: "plain" },
    vtxtable: { category: "vtx", label: `图传表 ${identity}`, valueType: "plain" },
    led: { category: "led", label: `LED ${identity}`, valueType: "plain" },
    color: { category: "led", label: `LED 颜色 ${identity}`, valueType: "plain" },
    mode_color: { category: "led", label: `LED 模式颜色 ${identity}`, valueType: "plain" },
    servo: { category: "servos", label: `舵机 ${identity}`, valueType: "plain" },
    smix: { category: "servos", label: `舵机混控 ${identity}`, valueType: "plain" },
    mmix: { category: "motor", label: `电机混控 ${identity}`, valueType: "plain" },
  };
  const descriptor = commandDescriptors[name];
  if (descriptor) {
    return {
      canonicalPath: `${descriptor.category}.${name}.${identity}`,
      mapped: true,
      ...descriptor,
      ...scope,
    };
  }
  return {
    canonicalPath: `cli.raw.${key}`,
    category: "other",
    label: key,
    valueType: "plain",
    mapped: false,
    ...scope,
  };
}

export function describeConfigurationKey(key, format = "betaflight_cli") {
  const descriptor = format === "json" ? describeMspPath(key) : describeCliKey(key);
  return {
    rawKey: key,
    mappingVersion: CONFIGURATION_MAPPING_VERSION,
    category: descriptor.category || "other",
    categoryLabel: CATEGORY_LABELS[descriptor.category] || CATEGORY_LABELS.other,
    label: descriptor.label || key,
    canonicalPath: descriptor.canonicalPath || key,
    mapped: descriptor.mapped === true,
    profileType: descriptor.profileType || "",
    profileIndex: Number.isInteger(descriptor.profileIndex) ? descriptor.profileIndex : null,
    profileLabel: descriptor.profileLabel || "",
    valueType: descriptor.valueType || "plain",
    tableKind: descriptor.tableKind || "",
  };
}

function enumValue(value, values) {
  const text = String(value ?? "").trim();
  return values[text.toUpperCase()] || values[text] || text;
}

export function formatConfigurationValue(value, descriptor = {}) {
  const text = String(value ?? "").trim();
  if (!text) return "—";
  switch (descriptor.valueType) {
    case "boolean":
      return enumValue(text, {
        ON: "开启",
        OFF: "关闭",
        TRUE: "开启",
        FALSE: "关闭",
        "1": "开启",
        "0": "关闭",
        ENABLED: "开启",
        DISABLED: "关闭",
      });
    case "motorDirection":
      return enumValue(text, {
        REVERSED: "外转",
        NORMAL: "内转",
        ON: "外转",
        OFF: "内转",
        TRUE: "外转",
        FALSE: "内转",
        "1": "外转",
        "0": "内转",
      });
    case "motorProtocol":
      return enumValue(text, {
        "0": "PWM",
        "1": "ONESHOT125",
        "2": "ONESHOT42",
        "3": "MULTISHOT",
        "4": "BRUSHED",
        "5": "DSHOT150",
        "6": "DSHOT300",
        "7": "DSHOT600",
        "8": "PROSHOT1000 / DSHOT1200（取决于旧固件）",
        "9": "禁用",
      });
    case "throttleLimitType":
      return enumValue(text, {
        "0": "关闭",
        "1": "缩放",
        "2": "截断",
        OFF: "关闭",
        SCALE: "缩放",
        CLIP: "截断",
      });
    case "ratesType":
      return enumValue(text, {
        "0": "Betaflight",
        "1": "Raceflight",
        "2": "KISS",
        "3": "Actual",
        "4": "Quick",
        BETAFLIGHT: "Betaflight",
        RACEFLIGHT: "Raceflight",
        ACTUAL: "Actual",
        QUICK: "Quick",
      });
    case "flightMode":
      return flightModeLabel(text);
    case "featureMask": {
      const mask = Number(text) >>> 0;
      const enabled = Object.entries(FEATURE_BIT_LABELS)
        .filter(([bit]) => (mask & (2 ** Number(bit))) !== 0)
        .map(([, label]) => label);
      return enabled.length ? enabled.join("、") : "全部关闭";
    }
    case "failsafeProcedure":
      return enumValue(text, {
        "0": "自动降落",
        "1": "立即断电",
        "2": "GPS 救援",
        AUTO_LANDING: "自动降落",
        DROP: "立即断电",
        GPS_RESCUE: "GPS 救援",
      });
    case "commandToggle":
      return /^-/.test(descriptor.rawKey?.split(/\s+/).at(-1) || "") ? "停用" : "启用";
    case "percent":
      return /%$/.test(text) ? text : `${text}%`;
    case "hz":
      return /(hz|khz)$/i.test(text) ? text : `${text} Hz`;
    case "mhz":
      return /mhz$/i.test(text) ? text : `${text} MHz`;
    case "degreesPerSecond":
      return /°\/s$/.test(text) ? text : `${text} °/s`;
    case "deciseconds":
      return `${text} × 0.1 秒`;
    case "vtxBand":
      return `频段 ${text}`;
    case "vtxChannel":
      return `频道 ${text}`;
    default:
      return text;
  }
}

export function decorateConfigurationDifference(item, format, valueKeys) {
  const descriptor = describeConfigurationKey(item.key, format);
  const decorated = { ...item, ...descriptor };
  if (
    descriptor.valueType === "featureMask"
    && valueKeys.includes("before")
    && valueKeys.includes("after")
  ) {
    const beforeMask = Number(item.before) >>> 0;
    const afterMask = Number(item.after) >>> 0;
    const changedMask = (beforeMask ^ afterMask) >>> 0;
    const changedLabels = Object.entries(FEATURE_BIT_LABELS)
      .filter(([bit]) => (changedMask & (2 ** Number(bit))) !== 0)
      .map(([bit, label]) => ({ bit: Number(bit), label }));
    if (changedLabels.length) {
      decorated.beforeDisplay = changedLabels
        .map(({ bit, label }) => `${label}：${(beforeMask & (2 ** bit)) !== 0 ? "开启" : "关闭"}`)
        .join("；");
      decorated.afterDisplay = changedLabels
        .map(({ bit, label }) => `${label}：${(afterMask & (2 ** bit)) !== 0 ? "开启" : "关闭"}`)
        .join("；");
      return decorated;
    }
  }
  for (const valueKey of valueKeys) {
    decorated[`${valueKey}Display`] = formatConfigurationValue(item[valueKey], descriptor);
  }
  return decorated;
}
