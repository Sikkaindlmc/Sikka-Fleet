import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins:[
    react(),
    tailwindcss(),
    VitePWA({
      registerType:'autoUpdate',
      manifest:{
        name:'Sikka Fleet',
        short_name:'Sikka Fleet',
        description:'SIKKA FLEET ERP',
        theme_color:'#171b4b',
        background_color:'#eef2f7',
        display:'standalone',
        start_url:'/',
        icons:[
          {src:'/pwa-192.png',sizes:'192x192',type:'image/png'},
          {src:'/pwa-512.png',sizes:'512x512',type:'image/png'},
          {src:'/pwa-maskable-512.png',sizes:'512x512',type:'image/png',purpose:'maskable'}
        ]
      },
      workbox:{
        navigateFallback:'/',
        navigateFallbackDenylist:[/^\/(?:api|uploads|share)(?:\/|$)/],
        runtimeCaching:[
          {urlPattern:/\/(?:api|uploads|share)(?:\/|$)/,handler:'NetworkOnly'}
        ]
      }
    })
  ],
  server:{
    port:5173,
    strictPort:false,
    proxy:{
      '/api':{target:'http://127.0.0.1:5000',changeOrigin:true},
      '/uploads':{target:'http://127.0.0.1:5000',changeOrigin:true},
      '/share':{target:'http://127.0.0.1:5000',changeOrigin:true}
    }
  }
})
