#ifndef USB_LINE_H
#define USB_LINE_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

void usb_line_init(void);
void usb_line_on_rx(const uint8_t *data, uint32_t len);
uint8_t usb_line_read(char *out, uint16_t out_size);
uint8_t usb_line_send(const char *text);
uint8_t usb_line_is_configured(void);

#ifdef __cplusplus
}
#endif

#endif
