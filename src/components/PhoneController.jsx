export default function PhoneController({ tone = 'blue', size = 'md' }) {
  return (
    <div className={`phone phone-${tone} phone-${size}`} aria-hidden="true">
      <div className="phone-screen">
        <span className="phone-stick" />
        <span className="phone-actions">
          <i />
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}
