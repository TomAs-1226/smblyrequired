// Section shell — vertical rhythm + top hairline + optional centered container.
// Pass `bleed` for full-bleed sections that manage their own width.
export default function Section({
  id,
  rule = true,
  tight = false,
  bleed = false,
  className = '',
  children,
  ...rest
}) {
  const cls = ['section', rule && 'section--rule', tight && 'section--tight', className]
    .filter(Boolean)
    .join(' ')
  return (
    <section id={id} className={cls} {...rest}>
      {bleed ? children : <div className="container">{children}</div>}
    </section>
  )
}
