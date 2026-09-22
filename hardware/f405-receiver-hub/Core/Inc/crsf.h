#ifndef CRSF_H
#define CRSF_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

#define CRSF_RC_CHANNEL_COUNT 16
#define CRSF_RC_USED_CHANNEL_COUNT 8
#define CRSF_EVENT_NONE       0x00U
#define CRSF_EVENT_RC         0x01U
#define CRSF_EVENT_LINK_STATS 0x02U

typedef struct {
  uint16_t ch[CRSF_RC_CHANNEL_COUNT];
  uint8_t lq;
  int8_t rssi;
} crsf_rc_frame_t;

typedef struct {
  uint8_t uplink_rssi_1;
  uint8_t uplink_rssi_2;
  uint8_t uplink_lq;
  int8_t uplink_snr;
  uint8_t active_antenna;
  uint8_t rf_mode;
  uint8_t uplink_tx_power;
  uint8_t downlink_rssi;
  uint8_t downlink_lq;
  int8_t downlink_snr;
} crsf_link_stats_t;

typedef struct {
  uint8_t buf[64];
  uint8_t len;
  uint32_t frames;
  uint32_t link_stats_frames;
  uint32_t crc_errors;
  uint32_t drops;
  crsf_link_stats_t link_stats;
} crsf_parser_t;

void crsf_parser_init(crsf_parser_t *parser);
uint8_t crsf_parser_push(crsf_parser_t *parser, uint8_t byte, crsf_rc_frame_t *out);

#ifdef __cplusplus
}
#endif

#endif
