#include "app_main.h"
#include "app_config.h"
#include "adc_monitor.h"
#include "crsf.h"
#include "gpio.h"
#include "rx_state.h"
#include "uart_mgr.h"
#include "usb_line.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define APP_LINE_LEN 512U
#define APP_JSON_LEN 1800U
#define APP_BIND_COUNT 3U
#define APP_BIND_INTERVAL_MS 100U

#if defined(__GNUC__)
#define APP_UNUSED __attribute__((unused))
#else
#define APP_UNUSED
#endif

typedef struct {
  uart_mgr_port_t port;
  uint8_t rx_id;
  crsf_parser_t parser;
  uint32_t last_crsf_frame_ms;
  uint32_t last_rc_frame_ms;
  uint32_t last_rx_pin_high_ms;
  uint8_t has_real_crsf;
} local_rx_port_t;

typedef struct {
  uart_mgr_port_t port;
  uint8_t node_id;
  char line[APP_LINE_LEN];
  uint16_t pos;
} node_link_t;

typedef struct {
  uint8_t active;
  uart_mgr_port_t port;
  uint8_t remaining;
  uint32_t next_ms;
} bind_task_t;

typedef struct {
  uint32_t default_pkt;
  uint32_t rc;
  uint32_t link;
} serial_debug_rx_t;

static const uint8_t bind_rx_frame[] = {0xC8U, 0x07U, 0x32U, 0xECU, 0xC8U, 0x10U, 0x01U, 0x9EU, 0xE8U};
static const uint16_t crsf_no_link_ch[CRSF_RC_USED_CHANNEL_COUNT] = {
  992U, 992U, 172U, 992U, 191U, 191U, 191U, 191U
};

static local_rx_port_t local_rx[APP_LOCAL_RX_COUNT] = {
  {.port = UART_MGR_USART1, .rx_id = 1U},
  {.port = UART_MGR_USART2, .rx_id = 2U},
  {.port = UART_MGR_USART3, .rx_id = 3U},
  {.port = UART_MGR_UART4,  .rx_id = 4U},
};

static node_link_t node_links[APP_MASTER_NODE_COUNT] = {
  {UART_MGR_USART1, 1U, {0}, 0U},
  {UART_MGR_USART2, 2U, {0}, 0U},
  {UART_MGR_USART3, 3U, {0}, 0U},
  {UART_MGR_UART4,  4U, {0}, 0U},
};

static node_link_t node_cmd_link = {UART_MGR_UART5, NODE_ID, {0}, 0U};
static bind_task_t bind_tasks[UART_MGR_COUNT];
static uint32_t last_batch_ms;
static uint32_t last_led_ms;
static uint32_t buzzer_until_ms;
static serial_debug_rx_t serial_debug_rx[APP_LOCAL_RX_COUNT];
static uint32_t serial_debug_last_ms;
#if APP_SERIAL_DEBUG && (APP_ROLE == APP_ROLE_STANDALONE_RX4)
static uint8_t serial_debug_next_rx;
#endif
static uint32_t serial_debug_rx_batch_count;

static void APP_UNUSED app_configure_role_uarts(void);
static void APP_UNUSED app_configure_rx_pin_pulldown(void);
static void APP_UNUSED app_sample_rx_pin_levels(void);
static uint8_t APP_UNUSED app_rx_pin_is_high(uint8_t rx_id);
static void APP_UNUSED app_process_local_crsf(void);
static void APP_UNUSED app_process_usb_commands(void);
static void APP_UNUSED app_process_node_uart_commands(void);
static void APP_UNUSED app_process_master_node_links(void);
static void APP_UNUSED app_handle_command(const char *line, uint8_t from_usb);
static void APP_UNUSED app_handle_bind(uint8_t rx);
static void APP_UNUSED app_start_role_rx(void);
static void APP_UNUSED app_schedule_bind(uart_mgr_port_t port);
static void APP_UNUSED app_process_bind_tasks(void);
static void APP_UNUSED app_send_ack(uint8_t rx, uint8_t ok, uint8_t node, uint8_t local);
static void APP_UNUSED app_send_rx_batch(void);
static void APP_UNUSED app_send_node_batch(void);
static void APP_UNUSED app_send_status(void);
static void APP_UNUSED app_append_rx_item(char *out, uint16_t out_len, uint16_t *pos,
                               uint8_t rx_id, const rx_state_t *state);
static uint8_t APP_UNUSED app_rx_should_output(uint8_t rx_id, uint32_t now);
static void APP_UNUSED app_send_to_usb_and_debug(const char *line);
static void APP_UNUSED app_parse_node_batch(uint8_t link_index, const char *line);
static void APP_UNUSED app_line_feed_node(node_link_t *link, int byte, uint8_t is_master_link);
static uint8_t APP_UNUSED app_parse_uint_after(const char *line, const char *key, uint8_t *out);
static void APP_UNUSED app_adc_task(void);
static void APP_UNUSED app_led_task(void);
static void APP_UNUSED app_serial_debug_task(void);

void app_main_init(void)
{
  memset(serial_debug_rx, 0, sizeof(serial_debug_rx));
  rx_state_init();
  usb_line_init();
  uart_mgr_init();
  app_configure_role_uarts();
#if APP_ROLE != APP_ROLE_MASTER
  /* Physical high-level presence describes a local receiver slot only.
   * A Master UART carries node traffic; sampling it as an RX pin once made
   * an empty node appear as phantom receivers RX1-RX4. */
  app_configure_rx_pin_pulldown();
#endif
  app_start_role_rx();

  for (uint8_t i = 0U; i < APP_LOCAL_RX_COUNT; i++) {
    crsf_parser_init(&local_rx[i].parser);
  }

  adc_monitor_init();
  HAL_GPIO_WritePin(BUZZER_GPIO_Port, BUZZER_Pin, GPIO_PIN_RESET);
  last_batch_ms = HAL_GetTick();
  last_led_ms = HAL_GetTick();
  serial_debug_last_ms = HAL_GetTick();
}

void app_main_loop(void)
{
  uint32_t now = HAL_GetTick();

  app_process_usb_commands();
#if APP_ROLE != APP_ROLE_MASTER
  app_sample_rx_pin_levels();
#endif
  app_process_bind_tasks();
  app_adc_task();
  app_led_task();

#if APP_ROLE == APP_ROLE_MASTER
  app_process_master_node_links();
  if ((now - last_batch_ms) >= APP_RX_BATCH_PERIOD_MS) {
    last_batch_ms = now;
    app_send_rx_batch();
  }
#elif APP_ROLE == APP_ROLE_NODE
  app_process_local_crsf();
  app_process_node_uart_commands();
  if ((now - last_batch_ms) >= APP_NODE_BATCH_PERIOD_MS) {
    last_batch_ms = now;
    app_send_node_batch();
  }
#else
  app_process_local_crsf();
  if ((now - last_batch_ms) >= APP_RX_BATCH_PERIOD_MS) {
    last_batch_ms = now;
    app_send_rx_batch();
  }
#endif

  if ((buzzer_until_ms != 0U) && ((int32_t)(now - buzzer_until_ms) >= 0)) {
    HAL_GPIO_WritePin(BUZZER_GPIO_Port, BUZZER_Pin, GPIO_PIN_RESET);
    buzzer_until_ms = 0U;
  }

  app_serial_debug_task();
}

void buzzer_beep(uint32_t ms)
{
  HAL_GPIO_WritePin(BUZZER_GPIO_Port, BUZZER_Pin, GPIO_PIN_SET);
  buzzer_until_ms = HAL_GetTick() + ms;
}

static void app_configure_role_uarts(void)
{
#if APP_ROLE == APP_ROLE_MASTER
  (void)uart_mgr_set_baud(UART_MGR_USART1, APP_NODE_LINK_BAUD);
  (void)uart_mgr_set_baud(UART_MGR_USART2, APP_NODE_LINK_BAUD);
  (void)uart_mgr_set_baud(UART_MGR_USART3, APP_NODE_LINK_BAUD);
  (void)uart_mgr_set_baud(UART_MGR_UART4, APP_NODE_LINK_BAUD);
  (void)uart_mgr_set_baud(UART_MGR_UART5, APP_NODE_LINK_BAUD);
#elif APP_ROLE == APP_ROLE_NODE
  (void)uart_mgr_set_baud(UART_MGR_USART1, APP_CRSF_BAUD);
  (void)uart_mgr_set_baud(UART_MGR_USART2, APP_CRSF_BAUD);
  (void)uart_mgr_set_baud(UART_MGR_USART3, APP_CRSF_BAUD);
  (void)uart_mgr_set_baud(UART_MGR_UART4, APP_CRSF_BAUD);
  (void)uart_mgr_set_baud(UART_MGR_UART5, APP_NODE_LINK_BAUD);
#else
  (void)uart_mgr_set_baud(UART_MGR_USART1, APP_CRSF_BAUD);
  (void)uart_mgr_set_baud(UART_MGR_USART2, APP_CRSF_BAUD);
  (void)uart_mgr_set_baud(UART_MGR_USART3, APP_CRSF_BAUD);
  (void)uart_mgr_set_baud(UART_MGR_UART4, APP_CRSF_BAUD);
  (void)uart_mgr_set_baud(UART_MGR_UART5, APP_NODE_LINK_BAUD);
#endif
}

static void app_configure_rx_pin_pulldown(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};

  GPIO_InitStruct.Mode = GPIO_MODE_AF_PP;
  GPIO_InitStruct.Pull = GPIO_PULLDOWN;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_VERY_HIGH;

  GPIO_InitStruct.Pin = GPIO_PIN_10;
  GPIO_InitStruct.Alternate = GPIO_AF7_USART1;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);

  GPIO_InitStruct.Pin = GPIO_PIN_3;
  GPIO_InitStruct.Alternate = GPIO_AF7_USART2;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);

  GPIO_InitStruct.Pin = GPIO_PIN_11;
  GPIO_InitStruct.Alternate = GPIO_AF7_USART3;
  HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);

  GPIO_InitStruct.Pin = GPIO_PIN_1;
  GPIO_InitStruct.Alternate = GPIO_AF8_UART4;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);
}

static void app_sample_rx_pin_levels(void)
{
  uint32_t now = HAL_GetTick();

  for (uint8_t rx = 1U; rx <= APP_LOCAL_RX_COUNT; rx++) {
    if (app_rx_pin_is_high(rx) != 0U) {
      const rx_state_t *state = rx_state_get(rx);

      local_rx[rx - 1U].last_rx_pin_high_ms = now;
      if (((local_rx[rx - 1U].has_real_crsf == 0U) ||
           ((now - local_rx[rx - 1U].last_rc_frame_ms) > APP_RX_ONLINE_TIMEOUT_MS)) &&
          ((state == 0) || (state->has_data == 0U) ||
           ((now - state->last_update_ms) > APP_RX_PHYSICAL_TIMEOUT_MS))) {
        local_rx[rx - 1U].has_real_crsf = 0U;
        rx_state_update_with_timeout(rx, crsf_no_link_ch, 0U,
                                     (int8_t)APP_DEFAULT_RSSI_DBM, now,
                                     APP_RX_UNBOUND_TIMEOUT_MS);
        serial_debug_rx[rx - 1U].default_pkt++;
      }
    }
  }
}

static uint8_t app_rx_pin_is_high(uint8_t rx_id)
{
  switch (rx_id) {
  case 1U:
    return (HAL_GPIO_ReadPin(GPIOA, GPIO_PIN_10) == GPIO_PIN_SET) ? 1U : 0U;
  case 2U:
    return (HAL_GPIO_ReadPin(GPIOA, GPIO_PIN_3) == GPIO_PIN_SET) ? 1U : 0U;
  case 3U:
    return (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_11) == GPIO_PIN_SET) ? 1U : 0U;
  case 4U:
    return (HAL_GPIO_ReadPin(GPIOA, GPIO_PIN_1) == GPIO_PIN_SET) ? 1U : 0U;
  default:
    return 0U;
  }
}

static void app_start_role_rx(void)
{
#if APP_ROLE == APP_ROLE_MASTER
  (void)uart_mgr_start_rx(UART_MGR_USART1);
  (void)uart_mgr_start_rx(UART_MGR_USART2);
  (void)uart_mgr_start_rx(UART_MGR_USART3);
  (void)uart_mgr_start_rx(UART_MGR_UART4);
#elif APP_ROLE == APP_ROLE_NODE
  uart_mgr_start_all_rx();
#else
  (void)uart_mgr_start_rx(UART_MGR_USART1);
  (void)uart_mgr_start_rx(UART_MGR_USART2);
  (void)uart_mgr_start_rx(UART_MGR_USART3);
  (void)uart_mgr_start_rx(UART_MGR_UART4);
#endif
}

static void app_process_local_crsf(void)
{
  crsf_rc_frame_t frame;

  for (uint8_t i = 0U; i < APP_LOCAL_RX_COUNT; i++) {
    int byte;

    while ((byte = uart_mgr_read_byte(local_rx[i].port)) >= 0) {
      uint8_t event = crsf_parser_push(&local_rx[i].parser, (uint8_t)byte, &frame);

      if ((event & CRSF_EVENT_LINK_STATS) != 0U) {
        uint32_t now = HAL_GetTick();
        const rx_state_t *state = rx_state_get(local_rx[i].rx_id);
        uint8_t rc_recent = ((local_rx[i].has_real_crsf != 0U) &&
                             ((now - local_rx[i].last_rc_frame_ms) <= APP_RX_ONLINE_TIMEOUT_MS));

        local_rx[i].last_crsf_frame_ms = now;
        serial_debug_rx[i].link++;

        if (rc_recent == 0U) {
          local_rx[i].has_real_crsf = 0U;
          rx_state_update_with_timeout(local_rx[i].rx_id, crsf_no_link_ch,
                                       frame.lq, frame.rssi, now,
                                       APP_RX_UNBOUND_TIMEOUT_MS);
          serial_debug_rx[i].default_pkt++;
        } else if ((state == 0) || (state->has_data == 0U)) {
          rx_state_update(local_rx[i].rx_id, crsf_no_link_ch, frame.lq, frame.rssi, now);
        } else {
          rx_state_update_link(local_rx[i].rx_id, frame.lq, frame.rssi, now);
        }
      }

      if ((event & CRSF_EVENT_RC) != 0U) {
        uint32_t now = HAL_GetTick();
        const rx_state_t *state = rx_state_get(local_rx[i].rx_id);

        local_rx[i].has_real_crsf = 1U;
        local_rx[i].last_crsf_frame_ms = now;
        local_rx[i].last_rc_frame_ms = now;
        serial_debug_rx[i].rc++;
        if (state != 0) {
          frame.lq = state->lq;
          frame.rssi = state->rssi;
        }
        rx_state_update(local_rx[i].rx_id, frame.ch, frame.lq, frame.rssi, now);
      }
    }
  }
}

static void app_process_usb_commands(void)
{
  char line[128];

  while (usb_line_read(line, sizeof(line)) != 0U) {
    app_handle_command(line, 1U);
  }
}

static void app_process_node_uart_commands(void)
{
  int byte;

  while ((byte = uart_mgr_read_byte(node_cmd_link.port)) >= 0) {
    app_line_feed_node(&node_cmd_link, byte, 0U);
  }
}

static void app_process_master_node_links(void)
{
  for (uint8_t i = 0U; i < APP_MASTER_NODE_COUNT; i++) {
    int byte;

    while ((byte = uart_mgr_read_byte(node_links[i].port)) >= 0) {
      app_line_feed_node(&node_links[i], byte, 1U);
    }
  }
}

static void app_line_feed_node(node_link_t *link, int byte, uint8_t is_master_link)
{
  char c = (char)byte;

  if (c == '\r') {
    return;
  }

  if (c == '\n') {
    link->line[link->pos] = '\0';
    if (link->pos > 0U) {
      if (is_master_link != 0U) {
        app_parse_node_batch((uint8_t)(link->node_id - 1U), link->line);
      } else {
        app_handle_command(link->line, 0U);
      }
    }
    link->pos = 0U;
    return;
  }

  if (link->pos < (APP_LINE_LEN - 1U)) {
    link->line[link->pos++] = c;
  } else {
    link->pos = 0U;
  }
}

static void app_handle_command(const char *line, uint8_t from_usb)
{
  uint8_t rx;

  (void)from_usb;
  if (strncmp(line, "BIND:", 5U) == 0) {
    rx = (uint8_t)strtoul(&line[5], 0, 10);
    app_handle_bind(rx);
  }
}

static void app_handle_bind(uint8_t rx)
{
#if APP_ROLE == APP_ROLE_MASTER
  uint8_t node;
  uint8_t local;
  char cmd[16];

  if ((rx < 1U) || (rx > APP_MASTER_RX_COUNT)) {
    app_send_ack(rx, 0U, 0U, 0U);
    return;
  }

  node = (uint8_t)(((rx - 1U) / 4U) + 1U);
  local = (uint8_t)(((rx - 1U) % 4U) + 1U);
  (void)snprintf(cmd, sizeof(cmd), "BIND:%u\n", local);
  (void)uart_mgr_send_text(node_links[node - 1U].port, cmd);
  app_send_ack(rx, 1U, node, local);
#else
  if ((rx < 1U) || (rx > APP_LOCAL_RX_COUNT)) {
    app_send_ack(rx, 0U, 0U, 0U);
    return;
  }

  app_schedule_bind(local_rx[rx - 1U].port);
  app_send_ack(rx, 1U, 0U, rx);
#endif
}

static void app_schedule_bind(uart_mgr_port_t port)
{
  bind_tasks[port].active = 1U;
  bind_tasks[port].port = port;
  bind_tasks[port].remaining = APP_BIND_COUNT;
  bind_tasks[port].next_ms = HAL_GetTick();
}

static void app_process_bind_tasks(void)
{
  uint32_t now = HAL_GetTick();

  for (uint8_t i = 0U; i < UART_MGR_COUNT; i++) {
    bind_task_t *task = &bind_tasks[i];

    if ((task->active == 0U) || ((int32_t)(now - task->next_ms) < 0)) {
      continue;
    }

    if (uart_mgr_send(task->port, bind_rx_frame, sizeof(bind_rx_frame)) == HAL_OK) {
      task->remaining--;
      task->next_ms = now + APP_BIND_INTERVAL_MS;
      if (task->remaining == 0U) {
        task->active = 0U;
      }
    }
  }
}

static void app_send_ack(uint8_t rx, uint8_t ok, uint8_t node, uint8_t local)
{
  char line[128];

#if APP_ROLE == APP_ROLE_MASTER
  (void)snprintf(line, sizeof(line),
                 "{\"type\":\"ack\",\"cmd\":\"BIND\",\"rx\":%u,\"ok\":%s,\"node\":%u,\"local\":%u}\n",
                 rx, ok ? "true" : "false", node, local);
#else
  (void)node;
  (void)local;
  (void)snprintf(line, sizeof(line),
                 "{\"type\":\"ack\",\"cmd\":\"BIND\",\"rx\":%u,\"ok\":%s}\n",
                 rx, ok ? "true" : "false");
#endif

#if APP_ROLE == APP_ROLE_NODE
  (void)uart_mgr_send_text(UART_MGR_UART5, line);
#endif
  (void)usb_line_send(line);
}

static void app_send_rx_batch(void)
{
  char line[APP_JSON_LEN];
  uint16_t pos = 0U;
  uint32_t now = HAL_GetTick();
  uint8_t first = 1U;
  uint8_t max_rx;
  uint32_t vin_mv = 0U;
  uint32_t current_ma = 0U;

  serial_debug_rx_batch_count++;

  adc_monitor_get_mv_ma(&vin_mv, &current_ma);

#if APP_ROLE == APP_ROLE_MASTER
  max_rx = APP_MASTER_RX_COUNT;
  pos = (uint16_t)snprintf(line, sizeof(line),
                           "{\"type\":\"rx_batch\",\"v\":1,\"role\":\"master\",\"Vin_mV\":%lu,\"A_mA\":%lu,\"t\":%lu,\"items\":[",
                           (unsigned long)vin_mv,
                           (unsigned long)current_ma,
                           (unsigned long)now);
#else
  max_rx = APP_LOCAL_RX_COUNT;
  pos = (uint16_t)snprintf(line, sizeof(line),
                           "{\"type\":\"rx_batch\",\"v\":1,\"role\":\"standalone\",\"Vin_mV\":%lu,\"A_mA\":%lu,\"t\":%lu,\"items\":[",
                           (unsigned long)vin_mv,
                           (unsigned long)current_ma,
                           (unsigned long)now);
#endif

  for (uint8_t rx = 1U; rx <= max_rx; rx++) {
    const rx_state_t *state = rx_state_get(rx);

    if ((state == 0) || (app_rx_should_output(rx, now) == 0U)) {
      continue;
    }

    if (first == 0U) {
      if (pos < (sizeof(line) - 1U)) {
        line[pos++] = ',';
        line[pos] = '\0';
      }
    }
    first = 0U;
    app_append_rx_item(line, sizeof(line), &pos, rx, state);
  }

  if (pos < (sizeof(line) - 3U)) {
    line[pos++] = ']';
    line[pos++] = '}';
    line[pos++] = '\n';
    line[pos] = '\0';
  }

  (void)usb_line_send(line);
}

static void app_send_node_batch(void)
{
  char line[APP_JSON_LEN];
  uint16_t pos = 0U;
  uint32_t now = HAL_GetTick();
  uint8_t first = 1U;
  uint32_t vin_mv = 0U;
  uint32_t current_ma = 0U;

  adc_monitor_get_mv_ma(&vin_mv, &current_ma);

  pos = (uint16_t)snprintf(line, sizeof(line),
                           "{\"type\":\"node_batch\",\"role\":\"node\",\"node\":%u,\"Vin_mV\":%lu,\"A_mA\":%lu,\"t\":%lu,\"items\":[",
                           NODE_ID,
                           (unsigned long)vin_mv,
                           (unsigned long)current_ma,
                           (unsigned long)now);

  for (uint8_t rx = 1U; rx <= APP_LOCAL_RX_COUNT; rx++) {
    const rx_state_t *state = rx_state_get(rx);

    if ((state == 0) || (app_rx_should_output(rx, now) == 0U)) {
      continue;
    }

    if (first == 0U) {
      if (pos < (sizeof(line) - 1U)) {
        line[pos++] = ',';
        line[pos] = '\0';
      }
    }
    first = 0U;
    app_append_rx_item(line, sizeof(line), &pos, rx, state);
  }

  if (pos < (sizeof(line) - 3U)) {
    line[pos++] = ']';
    line[pos++] = '}';
    line[pos++] = '\n';
    line[pos] = '\0';
  }

  (void)uart_mgr_send_text(UART_MGR_UART5, line);
}

static void app_send_status(void)
{
  char line[APP_JSON_LEN];
  uint32_t err[UART_MGR_COUNT];
  uint32_t now = HAL_GetTick();
  uint16_t vin_raw = 0U;
  uint16_t cur_raw = 0U;
  uint32_t vin_mv = 0U;
  uint32_t current_ma = 0U;

  uart_mgr_get_error_counts(err);
  adc_monitor_get_raw(&vin_raw, &cur_raw);
  adc_monitor_get_mv_ma(&vin_mv, &current_ma);

#if APP_ROLE == APP_ROLE_MASTER
  if (adc_monitor_is_ok() != 0U) {
    (void)snprintf(line, sizeof(line),
                   "{\"type\":\"status\",\"role\":\"master\",\"t\":%lu,\"online\":%u,\"uart_err\":[%lu,%lu,%lu,%lu,%lu],\"adc_raw\":[%u,%u],\"vin_mv\":%lu,\"current_ma\":%lu}\n",
                   (unsigned long)now,
                   rx_state_count_online(1U, APP_MASTER_RX_COUNT, now),
                   (unsigned long)err[0], (unsigned long)err[1], (unsigned long)err[2],
                   (unsigned long)err[3], (unsigned long)err[4],
                   vin_raw, cur_raw,
                   (unsigned long)vin_mv, (unsigned long)current_ma);
  } else {
    (void)snprintf(line, sizeof(line),
                   "{\"type\":\"status\",\"role\":\"master\",\"t\":%lu,\"online\":%u,\"uart_err\":[%lu,%lu,%lu,%lu,%lu],\"adc\":\"error\"}\n",
                   (unsigned long)now,
                   rx_state_count_online(1U, APP_MASTER_RX_COUNT, now),
                   (unsigned long)err[0], (unsigned long)err[1], (unsigned long)err[2],
                   (unsigned long)err[3], (unsigned long)err[4]);
  }
  (void)usb_line_send(line);
#elif APP_ROLE == APP_ROLE_NODE
  (void)snprintf(line, sizeof(line),
                 "{\"type\":\"status\",\"role\":\"node\",\"node\":%u,\"t\":%lu,\"online\":%u,\"uart_err\":[%lu,%lu,%lu,%lu,%lu]}\n",
                 NODE_ID,
                 (unsigned long)now,
                 rx_state_count_online(1U, APP_LOCAL_RX_COUNT, now),
                 (unsigned long)err[0], (unsigned long)err[1], (unsigned long)err[2],
                 (unsigned long)err[3], (unsigned long)err[4]);
  app_send_to_usb_and_debug(line);
#else
  if (adc_monitor_is_ok() != 0U) {
    (void)snprintf(line, sizeof(line),
                   "{\"type\":\"status\",\"role\":\"standalone\",\"t\":%lu,\"usb\":\"%s\",\"online\":%u,\"uart_err\":[%lu,%lu,%lu,%lu,%lu],\"adc_raw\":[%u,%u],\"vin_mv\":%lu,\"current_ma\":%lu}\n",
                   (unsigned long)now,
                   usb_line_is_configured() ? "configured" : "wait",
                   rx_state_count_online(1U, APP_LOCAL_RX_COUNT, now),
                   (unsigned long)err[0], (unsigned long)err[1], (unsigned long)err[2],
                   (unsigned long)err[3], (unsigned long)err[4],
                   vin_raw, cur_raw,
                   (unsigned long)vin_mv, (unsigned long)current_ma);
  } else {
    (void)snprintf(line, sizeof(line),
                   "{\"type\":\"status\",\"role\":\"standalone\",\"t\":%lu,\"usb\":\"%s\",\"online\":%u,\"uart_err\":[%lu,%lu,%lu,%lu,%lu],\"adc\":\"error\"}\n",
                   (unsigned long)now,
                   usb_line_is_configured() ? "configured" : "wait",
                   rx_state_count_online(1U, APP_LOCAL_RX_COUNT, now),
                   (unsigned long)err[0], (unsigned long)err[1], (unsigned long)err[2],
                   (unsigned long)err[3], (unsigned long)err[4]);
  }
  (void)usb_line_send(line);
#endif
}

static void app_append_rx_item(char *out, uint16_t out_len, uint16_t *pos,
                               uint8_t rx_id, const rx_state_t *state)
{
  int n;

  if (*pos >= out_len) {
    return;
  }

  n = snprintf(&out[*pos], out_len - *pos,
               "{\"rx\":%u,\"ch\":[%u,%u,%u,%u,%u,%u,%u,%u],\"lq\":%u,\"rssi\":%d}",
               rx_id,
               state->ch[0], state->ch[1], state->ch[2], state->ch[3],
               state->ch[4], state->ch[5], state->ch[6], state->ch[7],
               state->lq, state->rssi);
  if ((n > 0) && ((uint16_t)n < (out_len - *pos))) {
    *pos = (uint16_t)(*pos + (uint16_t)n);
  } else {
    *pos = out_len;
  }
}

static uint8_t app_rx_should_output(uint8_t rx_id, uint32_t now)
{
  const rx_state_t *state = rx_state_get(rx_id);

  if ((state == 0) || (rx_state_is_online(rx_id, now) == 0U)) {
    return 0U;
  }

#if (APP_ROLE == APP_ROLE_STANDALONE_RX4) || (APP_ROLE == APP_ROLE_NODE)
  if (rx_id <= APP_LOCAL_RX_COUNT) {
    local_rx_port_t *rx = &local_rx[rx_id - 1U];

    /* The 4.5 s unbound LinkStats hold smooths intermittent reports, but
     * must not keep a physically unplugged UART slot visible. This 100 ms
     * per-slot gate is not a receiver-identity/migration heuristic. */
    if ((now - rx->last_rx_pin_high_ms) > APP_RX_PHYSICAL_TIMEOUT_MS) {
      return 0U;
    }

    if ((rx->has_real_crsf != 0U) &&
        ((now - rx->last_rc_frame_ms) <= APP_RX_ONLINE_TIMEOUT_MS)) {
      return 1U;
    }
  }
#endif

  return 1U;
}

static void app_send_to_usb_and_debug(const char *line)
{
  (void)usb_line_send(line);
#if APP_ROLE == APP_ROLE_NODE
  (void)uart_mgr_send_text(UART_MGR_UART5, line);
#endif
}

static void app_parse_node_batch(uint8_t link_index, const char *line)
{
  uint8_t node = 0U;
  const char *p = line;

  if (strstr(line, "\"type\":\"node_batch\"") == 0) {
    return;
  }

  if (app_parse_uint_after(line, "\"node\":", &node) == 0U) {
    node = (uint8_t)(link_index + 1U);
  }

  if ((node < 1U) || (node > APP_MASTER_NODE_COUNT)) {
    return;
  }

  while ((p = strstr(p, "\"rx\":")) != 0) {
    uint8_t local_rx = (uint8_t)strtoul(p + 5, 0, 10);
    const char *ch_start = strstr(p, "\"ch\":[");
    const char *lq_start = strstr(p, "\"lq\":");
    const char *rssi_start = strstr(p, "\"rssi\":");
    uint16_t ch[CRSF_RC_USED_CHANNEL_COUNT] = {0};
    uint8_t lq = 0U;
    int8_t rssi = 0;

    if ((local_rx < 1U) || (local_rx > APP_LOCAL_RX_COUNT) || (ch_start == 0)) {
      p += 5;
      continue;
    }

    ch_start += 6;
    for (uint8_t i = 0U; i < CRSF_RC_USED_CHANNEL_COUNT; i++) {
      ch[i] = (uint16_t)strtoul(ch_start, (char **)&ch_start, 10);
      if (*ch_start == ',') {
        ch_start++;
      }
    }

    if (lq_start != 0) {
      lq = (uint8_t)strtoul(lq_start + 5, 0, 10);
    }
    if (rssi_start != 0) {
      rssi = (int8_t)strtol(rssi_start + 7, 0, 10);
    }

    rx_state_update((uint8_t)(((node - 1U) * 4U) + local_rx), ch, lq, rssi, HAL_GetTick());
    p += 5;
  }
}

static uint8_t app_parse_uint_after(const char *line, const char *key, uint8_t *out)
{
  const char *p = strstr(line, key);

  if (p == 0) {
    return 0U;
  }

  *out = (uint8_t)strtoul(p + strlen(key), 0, 10);
  return 1U;
}

static void app_adc_task(void)
{
  adc_monitor_poll();
}

static void app_led_task(void)
{
  uint32_t now = HAL_GetTick();
  uint32_t period = usb_line_is_configured() ? 250U : 500U;

  if ((now - last_led_ms) >= period) {
    last_led_ms = now;
    HAL_GPIO_TogglePin(LED_STATUS_GPIO_Port, LED_STATUS_Pin);
  }
}

static void app_serial_debug_task(void)
{
#if APP_SERIAL_DEBUG && (APP_ROLE == APP_ROLE_STANDALONE_RX4)
  char line[APP_JSON_LEN];
  uint32_t now = HAL_GetTick();
  uint8_t i = serial_debug_next_rx;
  const rx_state_t *state;
  uint8_t online;
  uint8_t phy;

  if ((now - serial_debug_last_ms) < APP_SERIAL_DEBUG_PERIOD_MS) {
    return;
  }

  if (i >= APP_LOCAL_RX_COUNT) {
    i = 0U;
  }

  state = rx_state_get((uint8_t)(i + 1U));
  online = app_rx_should_output((uint8_t)(i + 1U), now);
  phy = ((now - local_rx[i].last_rx_pin_high_ms) <= APP_RX_PHYSICAL_TIMEOUT_MS) ? 1U : 0U;

  (void)snprintf(line, sizeof(line),
                 "{\"type\":\"debug\",\"role\":\"standalone\",\"t\":%lu,"
                 "\"rx\":%u,\"online\":%u,\"phy\":%u,\"has\":%u,\"real\":%u,"
                 "\"def\":%lu,\"rc\":%lu,\"link\":%lu,\"crc\":%lu,\"drop\":%lu,"
                 "\"last_frame\":%lu,\"last_pin\":%lu,"
                 "\"rx_batch\":%lu}\n",
                 (unsigned long)now,
                 (unsigned int)(i + 1U),
                 online,
                 phy,
                 (state != 0) ? state->has_data : 0U,
                 local_rx[i].has_real_crsf,
                 (unsigned long)serial_debug_rx[i].default_pkt,
                 (unsigned long)serial_debug_rx[i].rc,
                 (unsigned long)serial_debug_rx[i].link,
                 (unsigned long)local_rx[i].parser.crc_errors,
                 (unsigned long)local_rx[i].parser.drops,
                 (unsigned long)local_rx[i].last_crsf_frame_ms,
                 (unsigned long)local_rx[i].last_rx_pin_high_ms,
                 (unsigned long)serial_debug_rx_batch_count);

  if (usb_line_send(line) != 0U) {
    serial_debug_last_ms = now;
    serial_debug_next_rx = (uint8_t)((i + 1U) % APP_LOCAL_RX_COUNT);
  }
#endif
}
