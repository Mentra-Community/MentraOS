#ifndef MOS_TEXT_DIAG_H_
#define MOS_TEXT_DIAG_H_

/* Count hard line breaks (LF/CR) in text and log an escaped preview.
 * No-op (omitted from build) unless CONFIG_MOS_DISPLAY_TEXT_PAYLOAD_DIAG is set. */
void mos_text_diag_log_payload(const char *text);

#endif /* MOS_TEXT_DIAG_H_ */
