#include "uart_mgr.h"
#include "usart.h"
#include <string.h>

#define UART_MGR_RX_DMA_LEN 256U
#define UART_MGR_RING_LEN   1024U
#define UART_MGR_TX_LEN     1024U

typedef struct {
  UART_HandleTypeDef *huart;
  uint8_t rx_dma[UART_MGR_RX_DMA_LEN];
  volatile uint16_t rx_pos;
  volatile uint16_t ring_head;
  volatile uint16_t ring_tail;
  uint8_t ring[UART_MGR_RING_LEN];
  uint8_t tx_buf[UART_MGR_TX_LEN];
  volatile uint8_t tx_busy;
  volatile uint32_t err_count;
} uart_mgr_ctx_t;

static uart_mgr_ctx_t uart_ctx[UART_MGR_COUNT];

static uart_mgr_port_t uart_mgr_port_from_handle(UART_HandleTypeDef *huart)
{
  if (huart->Instance == USART1) {
    return UART_MGR_USART1;
  }
  if (huart->Instance == USART2) {
    return UART_MGR_USART2;
  }
  if (huart->Instance == USART3) {
    return UART_MGR_USART3;
  }
  if (huart->Instance == UART4) {
    return UART_MGR_UART4;
  }
  return UART_MGR_UART5;
}

static void uart_mgr_ring_push(uart_mgr_ctx_t *ctx, uint8_t byte)
{
  uint16_t next = (uint16_t)((ctx->ring_head + 1U) % UART_MGR_RING_LEN);

  if (next == ctx->ring_tail) {
    ctx->err_count++;
    return;
  }

  ctx->ring[ctx->ring_head] = byte;
  ctx->ring_head = next;
}

static void uart_mgr_copy_rx(uart_mgr_ctx_t *ctx, uint16_t pos)
{
  uint16_t old_pos = ctx->rx_pos;

  if (pos > UART_MGR_RX_DMA_LEN) {
    ctx->err_count++;
    ctx->rx_pos = 0U;
    return;
  }

  if (pos == old_pos) {
    return;
  }

  if (pos > old_pos) {
    for (uint16_t i = old_pos; i < pos; i++) {
      uart_mgr_ring_push(ctx, ctx->rx_dma[i]);
    }
  } else {
    for (uint16_t i = old_pos; i < UART_MGR_RX_DMA_LEN; i++) {
      uart_mgr_ring_push(ctx, ctx->rx_dma[i]);
    }
    for (uint16_t i = 0U; i < pos; i++) {
      uart_mgr_ring_push(ctx, ctx->rx_dma[i]);
    }
  }

  ctx->rx_pos = pos;
}

void uart_mgr_init(void)
{
  memset(uart_ctx, 0, sizeof(uart_ctx));
  uart_ctx[UART_MGR_USART1].huart = &huart1;
  uart_ctx[UART_MGR_USART2].huart = &huart2;
  uart_ctx[UART_MGR_USART3].huart = &huart3;
  uart_ctx[UART_MGR_UART4].huart = &huart4;
  uart_ctx[UART_MGR_UART5].huart = &huart5;
}

HAL_StatusTypeDef uart_mgr_set_baud(uart_mgr_port_t port, uint32_t baud)
{
  UART_HandleTypeDef *huart;

  if (port >= UART_MGR_COUNT) {
    return HAL_ERROR;
  }

  huart = uart_ctx[port].huart;
  if (huart == 0) {
    return HAL_ERROR;
  }

  (void)HAL_UART_DeInit(huart);
  huart->Init.BaudRate = baud;
  huart->Init.WordLength = UART_WORDLENGTH_8B;
  huart->Init.StopBits = UART_STOPBITS_1;
  huart->Init.Parity = UART_PARITY_NONE;
  huart->Init.Mode = UART_MODE_TX_RX;
  huart->Init.HwFlowCtl = UART_HWCONTROL_NONE;
  huart->Init.OverSampling = UART_OVERSAMPLING_16;
  return HAL_UART_Init(huart);
}

HAL_StatusTypeDef uart_mgr_start_rx(uart_mgr_port_t port)
{
  uart_mgr_ctx_t *ctx;
  HAL_StatusTypeDef status;

  if (port >= UART_MGR_COUNT) {
    return HAL_ERROR;
  }

  ctx = &uart_ctx[port];
  ctx->rx_pos = 0U;
  status = HAL_UARTEx_ReceiveToIdle_DMA(ctx->huart, ctx->rx_dma, UART_MGR_RX_DMA_LEN);
  if ((status == HAL_OK) && (ctx->huart->hdmarx != 0)) {
    __HAL_DMA_DISABLE_IT(ctx->huart->hdmarx, DMA_IT_HT);
  }
  if (status != HAL_OK) {
    ctx->err_count++;
  }

  return status;
}

void uart_mgr_start_all_rx(void)
{
  for (uint8_t i = 0U; i < UART_MGR_COUNT; i++) {
    (void)uart_mgr_start_rx((uart_mgr_port_t)i);
  }
}

int uart_mgr_read_byte(uart_mgr_port_t port)
{
  uart_mgr_ctx_t *ctx;
  uint8_t byte;

  if (port >= UART_MGR_COUNT) {
    return -1;
  }

  ctx = &uart_ctx[port];
  if (ctx->ring_tail == ctx->ring_head) {
    return -1;
  }

  byte = ctx->ring[ctx->ring_tail];
  ctx->ring_tail = (uint16_t)((ctx->ring_tail + 1U) % UART_MGR_RING_LEN);
  return (int)byte;
}

HAL_StatusTypeDef uart_mgr_send(uart_mgr_port_t port, const uint8_t *data, uint16_t len)
{
  uart_mgr_ctx_t *ctx;

  if ((port >= UART_MGR_COUNT) || (data == 0) || (len == 0U) || (len > UART_MGR_TX_LEN)) {
    return HAL_ERROR;
  }

  ctx = &uart_ctx[port];
  if (ctx->tx_busy != 0U) {
    return HAL_BUSY;
  }

  memcpy(ctx->tx_buf, data, len);
  ctx->tx_busy = 1U;
  if (HAL_UART_Transmit_IT(ctx->huart, ctx->tx_buf, len) != HAL_OK) {
    ctx->tx_busy = 0U;
    return HAL_BUSY;
  }

  return HAL_OK;
}

HAL_StatusTypeDef uart_mgr_send_text(uart_mgr_port_t port, const char *text)
{
  uint16_t len = 0U;

  if (text == 0) {
    return HAL_ERROR;
  }

  while ((len < UART_MGR_TX_LEN) && (text[len] != '\0')) {
    len++;
  }

  if (len >= UART_MGR_TX_LEN) {
    return HAL_ERROR;
  }

  return uart_mgr_send(port, (const uint8_t *)text, len);
}

uint32_t uart_mgr_error_count(uart_mgr_port_t port)
{
  if (port >= UART_MGR_COUNT) {
    return 0U;
  }

  return uart_ctx[port].err_count;
}

void uart_mgr_get_error_counts(uint32_t out[UART_MGR_COUNT])
{
  for (uint8_t i = 0U; i < UART_MGR_COUNT; i++) {
    out[i] = uart_ctx[i].err_count;
  }
}

UART_HandleTypeDef *uart_mgr_handle(uart_mgr_port_t port)
{
  if (port >= UART_MGR_COUNT) {
    return 0;
  }

  return uart_ctx[port].huart;
}

void HAL_UARTEx_RxEventCallback(UART_HandleTypeDef *huart, uint16_t Size)
{
  uart_mgr_port_t port = uart_mgr_port_from_handle(huart);

  uart_mgr_copy_rx(&uart_ctx[port], Size);
}

void HAL_UART_TxCpltCallback(UART_HandleTypeDef *huart)
{
  uart_mgr_port_t port = uart_mgr_port_from_handle(huart);

  uart_ctx[port].tx_busy = 0U;
}

void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart)
{
  uart_mgr_port_t port = uart_mgr_port_from_handle(huart);

  uart_ctx[port].err_count++;
  uart_ctx[port].rx_pos = 0U;
  uart_ctx[port].tx_busy = 0U;
  (void)uart_mgr_start_rx(port);
}
