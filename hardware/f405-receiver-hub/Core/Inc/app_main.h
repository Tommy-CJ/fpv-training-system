#ifndef APP_MAIN_H
#define APP_MAIN_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

void app_main_init(void);
void app_main_loop(void);
void buzzer_beep(uint32_t ms);

#ifdef __cplusplus
}
#endif

#endif
