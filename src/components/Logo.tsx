import mark from "../assets/logo-mark.png";

/**
 * The Zero mark on a small white tile, matching the app icon. The tile keeps the
 * brand blue legible on the dark theme too.
 */
export default function Logo({ size = 28 }: { size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-[22%] border border-line bg-white"
      style={{ width: size, height: size }}
    >
      <img src={mark} alt="Zero" draggable={false} style={{ width: size * 0.74, height: size * 0.74 }} />
    </span>
  );
}
