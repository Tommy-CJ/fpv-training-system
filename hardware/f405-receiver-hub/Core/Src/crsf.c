#include "crsf.h"
#include "app_config.h"
#include <string.h>

#define CRSF_SYNC_MIN        0xC0U
#define CRSF_TYPE_LINK_STATISTICS    0x14U
#define CRSF_TYPE_LINK_STATISTICS_REPEATER 0x15U
#define CRSF_TYPE_RC_CHANNELS_PACKED 0x16U
#define CRSF_TYPE_LINK_STATISTICS_RX 0x1CU
#define CRSF_TYPE_LINK_STATISTICS_TX 0x1DU
#define CRSF_MAX_FRAME_LEN   64U
#define CRSF_MIN_LEN_FIELD   2U
#define CRSF_MAX_LEN_FIELD   62U
#define CRSF_RC_PAYLOAD_LEN  22U
#define CRSF_LINK_STATS_PAYLOAD_LEN 10U
#define CRSF_LINK_STATS_RX_PAYLOAD_LEN 5U
#define CRSF_LINK_STATS_TX_PAYLOAD_LEN 6U

static uint8_t crsf_crc8_d5(const uint8_t *data, uint8_t len)
{
  uint8_t crc = 0U;

  for (uint8_t i = 0U; i < len; i++) {
    crc ^= data[i];
    for (uint8_t bit = 0U; bit < 8U; bit++) {
      if ((crc & 0x80U) != 0U) {
        crc = (uint8_t)((crc << 1U) ^ 0xD5U);
      } else {
        crc <<= 1U;
      }
    }
  }

  return crc;
}

static uint16_t crsf_read_11bit(const uint8_t *payload, uint8_t channel)
{
  uint32_t bit_index = (uint32_t)channel * 11U;
  uint32_t byte_index = bit_index >> 3U;
  uint8_t bit_offset = (uint8_t)(bit_index & 7U);
  uint32_t value = payload[byte_index];

  value |= ((uint32_t)payload[byte_index + 1U] << 8U);
  value |= ((uint32_t)payload[byte_index + 2U] << 16U);

  return (uint16_t)((value >> bit_offset) & 0x07FFU);
}

static uint8_t crsf_frame_is_possible_start(uint8_t byte)
{
  return ((byte == 0x00U) || (byte >= CRSF_SYNC_MIN)) ? 1U : 0U;
}

static int8_t crsf_rssi_to_dbm(uint8_t rssi)
{
  if ((rssi == 0U) || (rssi > 127U)) {
    return (int8_t)APP_DEFAULT_RSSI_DBM;
  }

  return (int8_t)(0 - (int8_t)rssi);
}

static int8_t crsf_best_uplink_rssi_dbm(uint8_t rssi_1, uint8_t rssi_2)
{
  if (rssi_1 == 0U) {
    return crsf_rssi_to_dbm(rssi_2);
  }
  if (rssi_2 == 0U) {
    return crsf_rssi_to_dbm(rssi_1);
  }

  return crsf_rssi_to_dbm((rssi_1 < rssi_2) ? rssi_1 : rssi_2);
}

static uint8_t crsf_try_parse(crsf_parser_t *parser, crsf_rc_frame_t *out)
{
  uint8_t len_field;
  uint8_t total_len;
  uint8_t type;
  uint8_t crc_expected;
  uint8_t crc_actual;

  if (parser->len < 2U) {
    return 0U;
  }

  len_field = parser->buf[1];
  if ((len_field < CRSF_MIN_LEN_FIELD) || (len_field > CRSF_MAX_LEN_FIELD)) {
    memmove(&parser->buf[0], &parser->buf[1], parser->len - 1U);
    parser->len--;
    parser->drops++;
    return 0U;
  }

  total_len = (uint8_t)(len_field + 2U);
  if (total_len > CRSF_MAX_FRAME_LEN) {
    parser->len = 0U;
    parser->drops++;
    return 0U;
  }

  if (parser->len < total_len) {
    return 0U;
  }

  type = parser->buf[2];
  crc_expected = parser->buf[total_len - 1U];
  crc_actual = crsf_crc8_d5(&parser->buf[2], (uint8_t)(len_field - 1U));

  if (crc_actual != crc_expected) {
    parser->crc_errors++;
    memmove(&parser->buf[0], &parser->buf[1], parser->len - 1U);
    parser->len--;
    return 0U;
  }

  if ((type == CRSF_TYPE_RC_CHANNELS_PACKED) && (len_field >= (CRSF_RC_PAYLOAD_LEN + 2U))) {
    const uint8_t *payload = &parser->buf[3];

    for (uint8_t i = 0U; i < CRSF_RC_CHANNEL_COUNT; i++) {
      out->ch[i] = crsf_read_11bit(payload, i);
    }
    out->lq = 0U;
    out->rssi = (int8_t)APP_DEFAULT_RSSI_DBM;
    parser->frames++;

    if (parser->len > total_len) {
      memmove(&parser->buf[0], &parser->buf[total_len], parser->len - total_len);
    }
    parser->len = (uint8_t)(parser->len - total_len);
    return CRSF_EVENT_RC;
  }

  if (((type == CRSF_TYPE_LINK_STATISTICS) ||
       (type == CRSF_TYPE_LINK_STATISTICS_REPEATER)) &&
      (len_field >= (CRSF_LINK_STATS_PAYLOAD_LEN + 2U))) {
    const uint8_t *payload = &parser->buf[3];

    parser->link_stats.uplink_rssi_1 = payload[0];
    parser->link_stats.uplink_rssi_2 = payload[1];
    parser->link_stats.uplink_lq = payload[2];
    parser->link_stats.uplink_snr = (int8_t)payload[3];
    parser->link_stats.active_antenna = payload[4];
    parser->link_stats.rf_mode = payload[5];
    parser->link_stats.uplink_tx_power = payload[6];
    parser->link_stats.downlink_rssi = payload[7];
    parser->link_stats.downlink_lq = payload[8];
    parser->link_stats.downlink_snr = (int8_t)payload[9];
    parser->link_stats_frames++;

    out->lq = parser->link_stats.uplink_lq;
    out->rssi = crsf_best_uplink_rssi_dbm(parser->link_stats.uplink_rssi_1,
                                          parser->link_stats.uplink_rssi_2);

    if (parser->len > total_len) {
      memmove(&parser->buf[0], &parser->buf[total_len], parser->len - total_len);
    }
    parser->len = (uint8_t)(parser->len - total_len);
    return CRSF_EVENT_LINK_STATS;
  }

  if (((type == CRSF_TYPE_LINK_STATISTICS_RX) &&
       (len_field >= (CRSF_LINK_STATS_RX_PAYLOAD_LEN + 2U))) ||
      ((type == CRSF_TYPE_LINK_STATISTICS_TX) &&
       (len_field >= (CRSF_LINK_STATS_TX_PAYLOAD_LEN + 2U)))) {
    const uint8_t *payload = &parser->buf[3];

    parser->link_stats.uplink_rssi_1 = payload[0];
    parser->link_stats.uplink_rssi_2 = 0U;
    parser->link_stats.uplink_lq = payload[2];
    parser->link_stats.uplink_snr = (int8_t)payload[3];
    parser->link_stats.active_antenna = 0U;
    parser->link_stats.rf_mode = 0U;
    parser->link_stats.uplink_tx_power = payload[4];
    parser->link_stats.downlink_rssi = 0U;
    parser->link_stats.downlink_lq = 0U;
    parser->link_stats.downlink_snr = 0;
    parser->link_stats_frames++;

    out->lq = parser->link_stats.uplink_lq;
    out->rssi = crsf_rssi_to_dbm(parser->link_stats.uplink_rssi_1);

    if (parser->len > total_len) {
      memmove(&parser->buf[0], &parser->buf[total_len], parser->len - total_len);
    }
    parser->len = (uint8_t)(parser->len - total_len);
    return CRSF_EVENT_LINK_STATS;
  }

  if (parser->len > total_len) {
    memmove(&parser->buf[0], &parser->buf[total_len], parser->len - total_len);
  }
  parser->len = (uint8_t)(parser->len - total_len);
  return 0U;
}

void crsf_parser_init(crsf_parser_t *parser)
{
  memset(parser, 0, sizeof(*parser));
}

uint8_t crsf_parser_push(crsf_parser_t *parser, uint8_t byte, crsf_rc_frame_t *out)
{
  if ((parser->len == 0U) && (crsf_frame_is_possible_start(byte) == 0U)) {
    return 0U;
  }

  if (parser->len >= sizeof(parser->buf)) {
    parser->len = 0U;
    parser->drops++;
  }

  parser->buf[parser->len++] = byte;
  return crsf_try_parse(parser, out);
}
