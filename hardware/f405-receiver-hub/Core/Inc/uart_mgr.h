#ifndef UART_MGR_H
#define UART_MGR_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>
#include "stm32f4xx_hal.h"

typedef enum {
  UART_MGR_USART1 = 0,
  UART_MGR_USART2,
  UART_MGR_USART3,
  UART_MGR_UART4,
  UART_MGR_UART5,
  UART_MGR_COUNT
} uart_mgr_port_t;

void uart_mgr_init(void);
HAL_StatusTypeDef uart_mgr_set_baud(uart_mgr_port_t port, uint32_t baud);
HAL_StatusTypeDef uart_mgr_start_rx(uart_mgr_port_t port);
void uart_mgr_start_all_rx(void);
int uart_mgr_read_byte(uart_mgr_port_t port);
HAL_StatusTypeDef uart_mgr_send(uart_mgr_port_t port, const uint8_t *data, uint16_t len);
HAL_StatusTypeDef uart_mgr_send_text(uart_mgr_port_t port, const char *text);
uint32_t uart_mgr_error_count(uart_mgr_port_t port);
void uart_mgr_get_error_counts(uint32_t out[UART_MGR_COUNT]);
UART_HandleTypeDef *uart_mgr_handle(uart_mgr_port_t port);

#ifdef __cplusplus
}
#endif

#endif
