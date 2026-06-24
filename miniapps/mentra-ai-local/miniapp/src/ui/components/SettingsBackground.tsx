import './SettingsBackground.css';

/**
 * Animated gradient backdrop for the Settings page. Two blurred blob layers
 * (warm + cool) drift on long, offset loops for a subtle living-glow feel.
 * Purely decorative — non-interactive and behind all content.
 */
export default function SettingsBackground() {
  return (
    <div className="settings-bg" aria-hidden="true">
      <div className="settings-bg__layer settings-bg__cool" />
      <div className="settings-bg__layer settings-bg__warm" />
    </div>
  );
}
