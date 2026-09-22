#ifndef APP_CONFIG_H
#define APP_CONFIG_H

#define APP_ROLE_STANDALONE_RX4   1
#define APP_ROLE_MASTER           2
#define APP_ROLE_NODE             3

#ifndef APP_ROLE
#define APP_ROLE APP_ROLE_NODE
#endif

#ifndef NODE_ID
#define NODE_ID 3
#endif

#define APP_LOCAL_RX_COUNT         4
#define APP_MASTER_NODE_COUNT      4
#define APP_MASTER_RX_COUNT        16

#define APP_CRSF_BAUD              420000U
#define APP_NODE_LINK_BAUD         2000000U

#define APP_RX_BATCH_PERIOD_MS     33U
#define APP_NODE_BATCH_PERIOD_MS   20U
#define APP_STATUS_PERIOD_MS       1000U
#define APP_RX_ONLINE_TIMEOUT_MS   1500U
#define APP_RX_UNBOUND_TIMEOUT_MS  4500U
#define APP_RX_PHYSICAL_TIMEOUT_MS 100U
#define APP_ADC_PERIOD_MS          100U

#define APP_ADC_VREF_MV            3300UL
#define APP_ADC_FULL_SCALE         4095UL
#define APP_ADC_VIN_TOP_K          47UL
#define APP_ADC_VIN_BOTTOM_K       22UL
#define APP_ADC_CURRENT_GAIN       50UL
#define APP_ADC_CURRENT_RSHUNT_MOHM 10UL
#define APP_ADC_FILTER_SHIFT       6U
#define APP_ADC_VIN_DEADBAND_MV    10UL
#define APP_ADC_CURRENT_DEADBAND_MA 5UL

#define APP_DEFAULT_RSSI_DBM       (-127)

#define APP_SERIAL_DEBUG           0U
#define APP_SERIAL_DEBUG_PERIOD_MS 500U

#define APP_USB_VID                0x0483U
#define APP_USB_PID                0x5740U
#define APP_USB_MANUFACTURER       "TrainSystem"
#define APP_USB_PRODUCT            "TRAINING_HUB"
#define APP_USB_SERIAL             "TRAINING_HUB_001"

#endif
