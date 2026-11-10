/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: ["class"],
    content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
  	extend: {
  		maxWidth: {
  			// LARGURA UNICA DO SITE. Antes cada tela escolhia a sua: listagem,
  			// Planos e Dashboard em 7xl (1280px), Chat em 6xl, Catalogo em 5xl,
  			// e o anuncio em 1600px -- este ultimo fui eu que alarguei na secao
  			// 144, e foi o que deixou a diferenca gritante: numa tela de 1920 o
  			// anuncio sobrava 320px de margem e a listagem 640px, o dobro.
  			//
  			// 1440 e meio-termo deliberado: o anuncio perde pouco, a listagem
  			// ganha bastante, e a linha de texto nao estica a ponto de cansar.
  			// Mudar a largura do site agora e mudar ESTE numero (secao 149).
  			site: "1440px",
  		},
  		fontFamily: {
  			// Archivo é a família única do produto -- a hierarquia vem do eixo de
  			// peso (400 -> 900), não de trocar de fonte. Plex Mono é reservada a
  			// dado, código e microrrótulo (nunca texto corrido).
  			sans: ['Archivo', 'ui-sans-serif', 'system-ui', 'sans-serif'],
  			display: ['Archivo', 'ui-sans-serif', 'system-ui', 'sans-serif'],
  			mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
  		},
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)',
  			// Os raios grandes do Tailwind são reescritos de propósito: o código
  			// da aplicação usa rounded-xl/2xl em ~240 lugares e o padrão (12px/
  			// 16px) é justamente o que dá o ar de template. Reapertando aqui, o
  			// app inteiro fica mais anguloso sem editar página nenhuma.
  			xl: '0.3125rem',
  			'2xl': '0.375rem',
  			'3xl': '0.5rem',
  			// Raio dos cartões de listagem: 10px. É o meio-termo deliberado entre
  			// o quadrado do catálogo técnico (frio) e o rounded-2xl original
  			// (16px, "bolha"). Token nomeado em vez de valor solto justamente
  			// para não voltar a ter 7 raios sem critério no app.
  			card: '0.625rem',
  		},
  		boxShadow: {
  			// Sombras reescritas em tom quente (base ink-900) e muito mais
  			// discretas -- no sistema novo, separação é feita por fio de cabelo,
  			// não por cartão flutuante.
  			sm: '0 1px 2px 0 rgb(33 28 25 / 0.06)',
  			DEFAULT: '0 1px 3px 0 rgb(33 28 25 / 0.08)',
  			md: '0 2px 6px -1px rgb(33 28 25 / 0.10)',
  			lg: '0 6px 16px -4px rgb(33 28 25 / 0.12)',
  			xl: '0 12px 28px -8px rgb(33 28 25 / 0.16)',
  			'2xl': '0 24px 48px -12px rgb(33 28 25 / 0.20)',
  		},
  		colors: {
  			// ------------------------------------------------------------------
  			// PALETAS REESCRITAS (ver CONTEXTO.MD/Resumo.md seção 71)
  			//
  			// `slate` e `orange` são sobrescritas de propósito. O código da
  			// aplicação tem ~1091 usos de slate-* e ~228 de orange-*; redefinir a
  			// escala aqui converte o app inteiro de uma vez, sem tocar em 40
  			// arquivos. É um atalho consciente: a migração "certa" (trocar as
  			// cores literais pelos tokens semânticos) continua valendo, só deixou
  			// de ser pré-requisito para o redesign acontecer.
  			//
  			// `slate` deixa de ser cinza AZULADO (hue ~215) e passa a ser cinza
  			// QUENTE (hue ~28). Esse era o conflito central: laranja quente sobre
  			// cinza frio fazia o laranja parecer colado por cima do site.
  			// ------------------------------------------------------------------
  			slate: {
  				50: '#FAF8F6',
  				100: '#F3EFEB',
  				200: '#E6DFD8',
  				300: '#D2C8BE',
  				400: '#AFA298',
  				500: '#8A7D73',
  				600: '#6B5F57',
  				700: '#524841',
  				800: '#37302B',
  				900: '#211C19',
  				950: '#120F0D',
  			},
  			// Laranja da marca: mais profundo e mais vermelho que o orange-500 do
  			// Tailwind (#F97316), que é o laranja "padrão de fábrica".
  			orange: {
  				50: '#FFF3EC',
  				100: '#FFE3D3',
  				200: '#FFC2A3',
  				300: '#FF9A69',
  				400: '#FF6F34',
  				500: '#F94F0C',
  				600: '#DC3D02',
  				700: '#B52F06',
  				800: '#8F270D',
  				900: '#74230F',
  				950: '#3F0F05',
  			},
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			border: 'hsl(var(--border))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			chart: {
  				'1': 'hsl(var(--chart-1))',
  				'2': 'hsl(var(--chart-2))',
  				'3': 'hsl(var(--chart-3))',
  				'4': 'hsl(var(--chart-4))',
  				'5': 'hsl(var(--chart-5))'
  			},
  			sidebar: {
  				DEFAULT: 'hsl(var(--sidebar-background))',
  				foreground: 'hsl(var(--sidebar-foreground))',
  				primary: 'hsl(var(--sidebar-primary))',
  				'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
  				accent: 'hsl(var(--sidebar-accent))',
  				'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
  				border: 'hsl(var(--sidebar-border))',
  				ring: 'hsl(var(--sidebar-ring))'
  			}
  		},
  		keyframes: {
  			'accordion-down': {
  				from: {
  					height: '0'
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: '0'
  				}
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out'
  		}
  	}
  },
  plugins: [require("tailwindcss-animate")],
}