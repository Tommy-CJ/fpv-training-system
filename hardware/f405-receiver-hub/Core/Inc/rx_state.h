#ifndef RX_STATE_H
#define RX_STATE_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>
#include "crsf.h"

#define RX_STATE_MAX 16

typedef struct {
  uint16_t ch[CRSF_RC_USED_CHANNEL_COUNT];
  uint8_t lq;
  int8_t rssi;
  uint32_t last_update_ms;
  uint32_t timeout_ms;
  uint8_t has_data;
} rx_state_t;

void rx_state_init(void);
void rx_state_update(uint8_t rx_id, const uint16_t ch[CRSF_RC_USED_CHANNEL_COUNT],
                     uint8_t lq, int8_t rssi, uint32_t now_ms);
void rx_state_update_with_timeout(uint8_t rx_id, const uint16_t ch[CRSF_RC_USED_CHANNEL_COUNT],
                                  uint8_t lq, int8_t rssi, uint32_t now_ms,
                                  uint32_t timeout_ms);
void rx_state_update_link(uint8_t rx_id, uint8_t lq, int8_t rssi, uint32_t now_ms);
const rx_state_t *rx_state_get(uint8_t rx_id);
uint8_t rx_state_is_online(uint8_t rx_id, uint32_t now_ms);
uint8_t rx_state_count_online(uint8_t first_rx, uint8_t count, uint32_t now_ms);

#ifdef __cplusplus
}
#endif

#endif
