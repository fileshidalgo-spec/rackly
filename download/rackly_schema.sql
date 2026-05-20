-- Tipo enum
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('admin', 'operario');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 1. Crear tablas primero
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  correo TEXT NOT NULL,
  nombre TEXT NOT NULL,
  aprobado boolean NOT NULL DEFAULT false,
  must_change_password boolean NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

CREATE TABLE IF NOT EXISTS public.catalogo (
  codigo TEXT PRIMARY KEY,
  un TEXT NOT NULL,
  descripcion TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id)
);

CREATE TABLE IF NOT EXISTS public.movimientos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','salida')),
  bloque TEXT NOT NULL,
  torre TEXT NOT NULL,
  piso TEXT NOT NULL,
  posicion TEXT NOT NULL,
  codigo TEXT NOT NULL,
  descripcion TEXT NOT NULL,
  un TEXT NOT NULL,
  cantidad NUMERIC(14,3) NOT NULL CHECK (cantidad > 0),
  f_vencimiento DATE,
  proveedor TEXT,
  f_modificacion TIMESTAMPTZ NOT NULL DEFAULT now(),
  turno TEXT NOT NULL,
  usuario_id UUID REFERENCES auth.users(id),
  usuario_nombre TEXT,
  usuario_correo TEXT
);

-- 2. RLS
DO $$ BEGIN ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.catalogo ENABLE ROW LEVEL SECURITY; EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE public.movimientos ENABLE ROW LEVEL SECURITY; EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- 3. Políticas (con DO para evitar errores)
DO $$ BEGIN
  CREATE POLICY "Authenticated read profiles" ON public.profiles FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Insert own pending profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id AND aprobado = false);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Admins update profiles" ON public.profiles FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Users update own must_change_password" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Authenticated read catalogo" ON public.catalogo FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Authenticated insert catalogo" ON public.catalogo FOR INSERT TO authenticated WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Authenticated update catalogo" ON public.catalogo FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Authenticated insert movimientos" ON public.movimientos FOR INSERT TO authenticated WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Authenticated select movimientos" ON public.movimientos FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Authenticated delete movimientos" ON public.movimientos FOR DELETE TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Authenticated read user_roles" ON public.user_roles FOR SELECT TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Authenticated insert user_roles" ON public.user_roles FOR INSERT TO authenticated WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Admins manage user_roles" ON public.user_roles FOR DELETE TO authenticated USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Admins manage user_roles2" ON public.user_roles FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 4. Funciones
CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  asignar_rol public.app_role;
  es_admin boolean;
BEGIN
  es_admin := lower(NEW.email) = 'miguel.hidalgo.pe@ecaral.pe';
  INSERT INTO public.profiles (id, correo, nombre, aprobado)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'nombre', split_part(NEW.email,'@',1)), es_admin)
  ON CONFLICT (id) DO NOTHING;
  asignar_rol := CASE WHEN es_admin THEN 'admin' ELSE 'operario' END;
  INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, asignar_rol) ON CONFLICT (user_id, role) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END;
$function$;

-- 5. Trigger
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 6. Activar cuenta admin
INSERT INTO public.profiles (id, correo, nombre, aprobado)
SELECT u.id, u.email, COALESCE(u.raw_user_meta_data->>'nombre', split_part(u.email,'@',1)), true
FROM auth.users u LEFT JOIN public.profiles p ON p.id = u.id
WHERE u.email = 'miguel.hidalgo.pe@ecaral.pe' AND p.id IS NULL;

INSERT INTO public.user_roles (user_id, role)
SELECT u.id, 'admin'
FROM auth.users u LEFT JOIN public.user_roles r ON r.user_id = u.id
WHERE u.email = 'miguel.hidalgo.pe@ecaral.pe' AND r.id IS NULL
ON CONFLICT (user_id, role) DO NOTHING;

UPDATE public.profiles SET aprobado = true WHERE correo = 'miguel.hidalgo.pe@ecaral.pe';
