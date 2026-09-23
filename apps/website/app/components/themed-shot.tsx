// A product screenshot that follows the visitor's color scheme when a dark capture exists.
export function ThemedShot({
  name,
  alt,
  width,
  height,
  dark = true,
  priority = false,
}: {
  readonly name: string;
  readonly alt: string;
  readonly width: number;
  readonly height: number;
  readonly dark?: boolean;
  readonly priority?: boolean;
}) {
  return (
    <picture>
      {dark ? (
        <source srcSet={`/media/${name}-dark.webp`} media="(prefers-color-scheme: dark)" />
      ) : null}
      <img
        src={`/media/${name}${dark ? "-light" : ""}.webp`}
        alt={alt}
        width={width}
        height={height}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
      />
    </picture>
  );
}
