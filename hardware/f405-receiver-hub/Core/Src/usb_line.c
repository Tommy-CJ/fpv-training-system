#include "usb_line.h"
#include "usbd_cdc_if.h"
#include "usbd_def.h"
#include <string.h>

#define USB_LINE_MAX       128U
#define USB_LINE_QUEUE_LEN 4U
#define USB_TX_MAX         2048U

extern USBD_HandleTypeDef hUsbDeviceFS;

static char line_queue[USB_LINE_QUEUE_LEN][USB_LINE_MAX];
static volatile uint8_t line_head;
static volatile uint8_t line_tail;
static char line_build[USB_LINE_MAX];
static uint16_t line_pos;
static uint8_t tx_buf[USB_TX_MAX];

void usb_line_init(void)
{
  line_head = 0U;
  line_tail = 0U;
  line_pos = 0U;
}

void usb_line_on_rx(const uint8_t *data, uint32_t len)
{
  for (uint32_t i = 0U; i < len; i++) {
    char c = (char)data[i];

    if (c == '\r') {
      continue;
    }

    if (c == '\n') {
      uint8_t next = (uint8_t)((line_head + 1U) % USB_LINE_QUEUE_LEN);
      if ((line_pos > 0U) && (next != line_tail)) {
        line_build[line_pos] = '\0';
        memcpy(line_queue[line_head], line_build, line_pos + 1U);
        line_head = next;
      }
      line_pos = 0U;
      continue;
    }

    if (line_pos < (USB_LINE_MAX - 1U)) {
      line_build[line_pos++] = c;
    } else {
      line_pos = 0U;
    }
  }
}

uint8_t usb_line_read(char *out, uint16_t out_size)
{
  if ((out == 0) || (out_size == 0U) || (line_tail == line_head)) {
    return 0U;
  }

  strncpy(out, line_queue[line_tail], out_size - 1U);
  out[out_size - 1U] = '\0';
  line_tail = (uint8_t)((line_tail + 1U) % USB_LINE_QUEUE_LEN);
  return 1U;
}

uint8_t usb_line_send(const char *text)
{
  uint16_t len = 0U;

  if ((text == 0) || (usb_line_is_configured() == 0U)) {
    return 0U;
  }

  while ((len < USB_TX_MAX) && (text[len] != '\0')) {
    len++;
  }

  if ((len == 0U) || (len >= USB_TX_MAX)) {
    return 0U;
  }

  memcpy(tx_buf, text, len);
  return (CDC_Transmit_FS(tx_buf, len) == USBD_OK) ? 1U : 0U;
}

uint8_t usb_line_is_configured(void)
{
  return (hUsbDeviceFS.dev_state == USBD_STATE_CONFIGURED) ? 1U : 0U;
}
