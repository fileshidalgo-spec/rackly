"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"

/**
 * Wrapper del Toaster de sonner.
 * NOTA: Se eliminó useTheme() de next-themes porque la app NO usa ThemeProvider.
 * Sin ThemeProvider, useTheme() devuelve un fallback sin la propiedad `theme`,
 * lo cual en React 19 + static export puede causar error #321
 * ("Objects are not valid as a React child") durante la hidratación.
 * Se usa theme="light" fijo ya que la app no tiene modo oscuro.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
