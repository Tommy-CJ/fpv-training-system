#include "adc_monitor.h"
#include "app_config.h"
#include "adc.h"
#include "stm32f4xx_hal.h"

#define ADC_MONITOR_VIN_NUM       (APP_ADC_VIN_TOP_K + APP_ADC_VIN_BOTTOM_K)
#define ADC_MONITOR_VIN_DEN       APP_ADC_VIN_BOTTOM_K

static uint16_t adc_raw[2];
static uint32_t adc_filt_q[2];
static uint16_t adc_filt_raw[2];
static uint32_t adc_vin_mv_out;
static uint32_t adc_current_ma_out;
static uint8_t adc_filter_ready;
static volatile uint8_t adc_ok;

static uint8_t adc_monitor_start_dma(void)
{
  (void)HAL_ADC_Stop_DMA(&hadc1);

  if (HAL_ADC_Start_DMA(&hadc1, (uint32_t *)adc_raw, 2U) == HAL_OK) {
    adc_ok = 1U;
    return 1U;
  }

  adc_ok = 0U;
  return 0U;
}

static uint32_t adc_abs_diff_u32(uint32_t a, uint32_t b)
{
  return (a > b) ? (a - b) : (b - a);
}

static uint32_t adc_vin_raw_to_mv(uint16_t raw)
{
  return ((uint32_t)raw * APP_ADC_VREF_MV *
          ADC_MONITOR_VIN_NUM) / ADC_MONITOR_VIN_DEN /
         APP_ADC_FULL_SCALE;
}

static uint32_t adc_current_raw_to_ma(uint16_t raw)
{
  return ((uint32_t)raw * APP_ADC_VREF_MV * 1000UL) /
         APP_ADC_FULL_SCALE /
         APP_ADC_CURRENT_GAIN /
         APP_ADC_CURRENT_RSHUNT_MOHM;
}

void adc_monitor_init(void)
{
  adc_ok = 0U;
  adc_filter_ready = 0U;
  adc_filt_q[0] = 0U;
  adc_filt_q[1] = 0U;
  adc_filt_raw[0] = 0U;
  adc_filt_raw[1] = 0U;
  adc_vin_mv_out = 0U;
  adc_current_ma_out = 0U;
  (void)HAL_ADC_Stop_DMA(&hadc1);
  hadc1.Init.ContinuousConvMode = ENABLE;
  hadc1.Init.DMAContinuousRequests = ENABLE;
  hadc1.Init.EOCSelection = ADC_EOC_SEQ_CONV;
  if (HAL_ADC_Init(&hadc1) != HAL_OK) {
    adc_ok = 0U;
    return;
  }

  (void)adc_monitor_start_dma();
}

void adc_monitor_poll(void)
{
  uint32_t scale = (1UL << APP_ADC_FILTER_SHIFT);

  if ((adc_ok == 0U) || ((HAL_ADC_GetState(&hadc1) & HAL_ADC_STATE_ERROR_INTERNAL) != 0U)) {
    (void)adc_monitor_start_dma();
  }

  if (adc_filter_ready == 0U) {
    adc_filt_q[0] = (uint32_t)adc_raw[0] * scale;
    adc_filt_q[1] = (uint32_t)adc_raw[1] * scale;
    adc_filter_ready = 1U;
  } else {
    adc_filt_q[0] += (int32_t)((uint32_t)adc_raw[0] * scale - adc_filt_q[0]) >> APP_ADC_FILTER_SHIFT;
    adc_filt_q[1] += (int32_t)((uint32_t)adc_raw[1] * scale - adc_filt_q[1]) >> APP_ADC_FILTER_SHIFT;
  }

  adc_filt_raw[0] = (uint16_t)((adc_filt_q[0] + (scale / 2U)) / scale);
  adc_filt_raw[1] = (uint16_t)((adc_filt_q[1] + (scale / 2U)) / scale);

  {
    uint32_t vin_mv = adc_vin_raw_to_mv(adc_filt_raw[0]);
    uint32_t current_ma = adc_current_raw_to_ma(adc_filt_raw[1]);

    if ((adc_vin_mv_out == 0U) ||
        (adc_abs_diff_u32(vin_mv, adc_vin_mv_out) >= APP_ADC_VIN_DEADBAND_MV)) {
      adc_vin_mv_out = vin_mv;
    }

    if ((adc_current_ma_out == 0U) ||
        (adc_abs_diff_u32(current_ma, adc_current_ma_out) >= APP_ADC_CURRENT_DEADBAND_MA)) {
      adc_current_ma_out = current_ma;
    }
  }
}

void adc_monitor_get_raw(uint16_t *vin_raw, uint16_t *cur_raw)
{
  if (vin_raw != 0) {
    *vin_raw = adc_filt_raw[0];
  }
  if (cur_raw != 0) {
    *cur_raw = adc_filt_raw[1];
  }
}

void adc_monitor_get_values(float *vin_v, float *current_a)
{
  if (vin_v != 0) {
    *vin_v = ((float)adc_filt_raw[0] * (float)APP_ADC_VREF_MV / 1000.0f /
              (float)APP_ADC_FULL_SCALE) *
             (float)ADC_MONITOR_VIN_NUM / (float)ADC_MONITOR_VIN_DEN;
  }
  if (current_a != 0) {
    *current_a = ((float)adc_filt_raw[1] * (float)APP_ADC_VREF_MV /
                  (float)APP_ADC_FULL_SCALE) /
                 ((float)APP_ADC_CURRENT_GAIN * (float)APP_ADC_CURRENT_RSHUNT_MOHM);
  }
}

void adc_monitor_get_mv_ma(uint32_t *vin_mv, uint32_t *current_ma)
{
  if (vin_mv != 0) {
    *vin_mv = adc_vin_mv_out;
  }

  if (current_ma != 0) {
    *current_ma = adc_current_ma_out;
  }
}

uint8_t adc_monitor_is_ok(void)
{
  return adc_ok;
}

void HAL_ADC_ErrorCallback(ADC_HandleTypeDef *hadc)
{
  (void)hadc;
  adc_ok = 0U;
}
