export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: '14.5'
  }
  public: {
    Tables: {
      catalogo: {
        Row: {
          codigo: string
          descripcion: string
          un: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          codigo: string
          descripcion: string
          un: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          codigo?: string
          descripcion?: string
          un?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      movimientos: {
        Row: {
          bloque: string
          cantidad: number
          codigo: string
          descripcion: string
          f_modificacion: string
          f_vencimiento: string | null
          id: string
          piso: string
          posicion: string
          proveedor: string | null
          tipo: string
          torre: string
          turno: string
          un: string
          usuario_correo: string | null
          usuario_id: string | null
          usuario_nombre: string | null
        }
        Insert: {
          bloque: string
          cantidad: number
          codigo: string
          descripcion: string
          f_modificacion?: string
          f_vencimiento?: string | null
          id?: string
          piso: string
          posicion: string
          proveedor?: string | null
          tipo: string
          torre: string
          turno: string
          un: string
          usuario_correo?: string | null
          usuario_id?: string | null
          usuario_nombre?: string | null
        }
        Update: {
          bloque?: string
          cantidad?: number
          codigo?: string
          descripcion?: string
          f_modificacion?: string
          f_vencimiento?: string | null
          id?: string
          piso?: string
          posicion?: string
          proveedor?: string | null
          tipo?: string
          torre?: string
          turno?: string
          un?: string
          usuario_correo?: string | null
          usuario_id?: string | null
          usuario_nombre?: string | null
        }
        Relationships: []
      }
      piso_bloques: {
        Row: {
          codigo: string
          created_at: string
          descripcion: string
          id: string
          unidad: string
        }
        Insert: {
          codigo: string
          created_at?: string
          descripcion?: string
          id?: string
          unidad?: string
        }
        Update: {
          codigo?: string
          created_at?: string
          descripcion?: string
          id?: string
          unidad?: string
        }
        Relationships: []
      }
      piso_columna_bloques: {
        Row: {
          bloque_id: string
          columna_id: string
        }
        Insert: {
          bloque_id: string
          columna_id: string
        }
        Update: {
          bloque_id?: string
          columna_id?: string
        }
        Relationships: []
      }
      piso_columnas: {
        Row: {
          id: string
          letra: string
          sector_id: string
        }
        Insert: {
          id?: string
          letra: string
          sector_id: string
        }
        Update: {
          id?: string
          letra?: string
          sector_id?: string
        }
        Relationships: []
      }
      piso_movimiento_detalles: {
        Row: {
          bloque_id: string
          cantidad: number
          fecha_vencimiento: string | null
          id: string
          movimiento_id: string
          nivel_id: string
        }
        Insert: {
          bloque_id: string
          cantidad: number
          fecha_vencimiento?: string | null
          id?: string
          movimiento_id: string
          nivel_id: string
        }
        Update: {
          bloque_id?: string
          cantidad?: number
          fecha_vencimiento?: string | null
          id?: string
          movimiento_id?: string
          nivel_id?: string
        }
        Relationships: []
      }
      piso_movimientos: {
        Row: {
          fecha: string
          id: string
          numero_operacion: number
          tipo: string
          turno: string
          usuario_correo: string | null
          usuario_id: string | null
          usuario_nombre: string | null
        }
        Insert: {
          fecha?: string
          id?: string
          numero_operacion?: number
          tipo: string
          turno: string
          usuario_correo?: string | null
          usuario_id?: string | null
          usuario_nombre?: string | null
        }
        Update: {
          fecha?: string
          id?: string
          numero_operacion?: number
          tipo?: string
          turno?: string
          usuario_correo?: string | null
          usuario_id?: string | null
          usuario_nombre?: string | null
        }
        Relationships: []
      }
      piso_niveles: {
        Row: {
          codigo_ubicacion: string | null
          id: string
          numero: number
          posicion_id: string
        }
        Insert: {
          codigo_ubicacion?: string | null
          id?: string
          numero: number
          posicion_id: string
        }
        Update: {
          codigo_ubicacion?: string | null
          id?: string
          numero?: number
          posicion_id?: string
        }
        Relationships: []
      }
      piso_posiciones: {
        Row: {
          id: string
          numero: number
          subcolumna_id: string
        }
        Insert: {
          id?: string
          numero: number
          subcolumna_id: string
        }
        Update: {
          id?: string
          numero?: number
          subcolumna_id?: string
        }
        Relationships: []
      }
      piso_sectores: {
        Row: {
          created_at: string
          id: string
          n_columnas: number
          n_niveles: number
          n_posiciones: number
          n_subcolumnas: number
          nombre: string
          prefijo: string
        }
        Insert: {
          created_at?: string
          id?: string
          n_columnas?: number
          n_niveles?: number
          n_posiciones?: number
          n_subcolumnas?: number
          nombre: string
          prefijo: string
        }
        Update: {
          created_at?: string
          id?: string
          n_columnas?: number
          n_niveles?: number
          n_posiciones?: number
          n_subcolumnas?: number
          nombre?: string
          prefijo?: string
        }
        Relationships: []
      }
      piso_subcolumnas: {
        Row: {
          codigo: string
          columna_id: string
          id: string
        }
        Insert: {
          codigo: string
          columna_id: string
          id?: string
        }
        Update: {
          codigo?: string
          columna_id?: string
          id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          aprobado: boolean
          correo: string
          created_at: string
          id: string
          must_change_password: boolean
          nombre: string
        }
        Insert: {
          aprobado?: boolean
          correo: string
          created_at?: string
          id: string
          must_change_password?: boolean
          nombre: string
        }
        Update: {
          aprobado?: boolean
          correo?: string
          created_at?: string
          id?: string
          must_change_password?: boolean
          nombre?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: 'admin' | 'operario'
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: 'admin' | 'operario'
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: 'admin' | 'operario'
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: { _role: 'admin' | 'operario'; _user_id: string }
        Returns: boolean
      }
      ocupacion_celdas: {
        Args: never
        Returns: {
          bloque: string
          codigos: string[]
          piso: string
          posicion: string
          stock: number
          torre: string
        }[]
      }
      piso_registrar_movimiento: {
        Args: { _detalles: Json; _tipo: string; _turno: string }
        Returns: {
          fecha: string
          id: string
          numero_operacion: number
          tipo: string
          turno: string
          usuario_correo: string | null
          usuario_id: string | null
          usuario_nombre: string | null
        }
      }
      piso_stock_detalle_posicion: {
        Args: { _posicion_id: string }
        Returns: {
          bloque_descripcion: string
          bloque_id: string
          bloque_codigo: string
          bloque_unidad: string
          cantidad: number
          fecha_vencimiento: string
        }[]
      }
      piso_stock_sector_grid: {
        Args: { _sector_id: string }
        Returns: {
          bloque_id: string
          bloque_codigo: string
          columna_letra: string
          posicion_id: string
          posicion_numero: number
          stock_total: number
          subcolumna_codigo: string
          bloques_json: Json
        }[]
      }
      primer_nombre_usuario: {
        Args: { _correo: string; _nombre: string }
        Returns: string
      }
      stock_en_ubicacion: {
        Args: {
          _bloque: string
          _piso: string
          _posicion: string
          _torre: string
        }
        Returns: {
          codigo: string
          descripcion: string
          f_vencimiento: string
          proveedor: string
          stock: number
          ultimo_ingreso: string
          un: string
          usuario_primer_nombre: string
        }[]
      }
      // JHIA-79: RPC atómica con advisory lock para movimientos individuales
      registrar_movimiento_kardex: {
        Args: {
          p_tipo: string
          p_bloque: string
          p_torre: string
          p_piso: string
          p_posicion: string
          p_codigo: string
          p_descripcion: string
          p_un: string
          p_cantidad: number
          p_f_vencimiento: string | null
          p_turno: string
          p_usuario_id: string
          p_usuario_nombre: string | null
          p_usuario_correo: string | null
          p_proveedor: string | null
        }
        Returns: {
          success: boolean
          previous_stock: number
          new_stock: number
        }
      }
      // JHIA-79: RPC atómica con double advisory lock para traslados
      registrar_traslado_kardex: {
        Args: {
          p_codigo: string
          p_descripcion: string
          p_un: string
          p_cantidad: number
          p_orig_bloque: string
          p_orig_torre: string
          p_orig_piso: string
          p_orig_pos: string
          p_dest_bloque: string
          p_dest_torre: string
          p_dest_piso: string
          p_dest_pos: string
          p_turno: string
          p_usuario_id: string
          p_usuario_nombre: string | null
          p_usuario_correo: string | null
          p_f_vencimiento: string | null
          p_proveedor: string | null
          p_cantidad_ajuste: number
        }
        Returns: {
          success: boolean
          origin_previous_stock: number
          origin_new_stock: number
        }
      }
    }
    Enums: {
      app_role: 'admin' | 'operario'
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
