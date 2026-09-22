#include "rx_state.h"
#include "app_config.h"
#include <string.h>

static rx_state_t rx_states[RX_STATE_MAX];

void rx_state_init(void)
{
  memset(rx_states, 0, sizeof(rx_states));
}

void rx_state_update(uint8_t rx_id, const uint16_t ch[CRSF_RC_USED_CHANNEL_COUNT],
                     uint8_t lq, int8_t rssi, uint32_t now_ms)
{
  rx_state_update_with_timeout(rx_id, ch, lq, rssi, now_ms, APP_RX_ONLINE_TIMEOUT_MS);
}

void rx_state_update_with_timeout(uint8_t rx_id, const uint16_t ch[CRSF_RC_USED_CHANNEL_COUNT],
                                  uint8_t lq, int8_t rssi, uint32_t now_ms,
                                  uint32_t timeout_ms)
{
  rx_state_t *state;

  if ((rx_id == 0U) || (rx_id > RX_STATE_MAX)) {
    return;
  }

  state = &rx_states[rx_id - 1U];
  memcpy(state->ch, ch, sizeof(state->ch));
  state->lq = lq;
  state->rssi = rssi;
  state->last_update_ms = now_ms;
  state->timeout_ms = timeout_ms;
  state->has_data = 1U;
}

void rx_state_update_link(uint8_t rx_id, uint8_t lq, int8_t rssi, uint32_t now_ms)
{
  rx_state_t *state;

  if ((rx_id == 0U) || (rx_id > RX_STATE_MAX)) {
    return;
  }

  state = &rx_states[rx_id - 1U];
  state->lq = lq;
  state->rssi = rssi;
  if (state->has_data != 0U) {
    state->last_update_ms = now_ms;
    state->timeout_ms = APP_RX_ONLINE_TIMEOUT_MS;
  }
}

const rx_state_t *rx_state_get(uint8_t rx_id)
{
  if ((rx_id == 0U) || (rx_id > RX_STATE_MAX)) {
    return 0;
  }

  return &rx_states[rx_id - 1U];
}

uint8_t rx_state_is_online(uint8_t rx_id, uint32_t now_ms)
{
  const rx_state_t *state = rx_state_get(rx_id);

  if ((state == 0) || (state->has_data == 0U)) {
    return 0U;
  }

  return ((now_ms - state->last_update_ms) <= state->timeout_ms) ? 1U : 0U;
}

uint8_t rx_state_count_online(uint8_t first_rx, uint8_t count, uint32_t now_ms)
{
  uint8_t online = 0U;

  for (uint8_t i = 0U; i < count; i++) {
    if (rx_state_is_online((uint8_t)(first_rx + i), now_ms) != 0U) {
      online++;
    }
  }

  return online;
}
