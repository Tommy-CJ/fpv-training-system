#ifndef ADC_MONITOR_H
#define ADC_MONITOR_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

void adc_monitor_init(void);
void adc_monitor_poll(void);
void adc_monitor_get_raw(uint16_t *vin_raw, uint16_t *cur_raw);
void adc_monitor_get_values(float *vin_v, float *current_a);
void adc_monitor_get_mv_ma(uint32_t *vin_mv, uint32_t *current_ma);
uint8_t adc_monitor_is_ok(void);

#ifdef __cplusplus
}
#endif

#endif
