FROM node:20-alpine

# Installer PM2 globalement
RUN npm install -g pm2

# Creer le repertoire de travail
WORKDIR /app

# Copier les fichiers de dependances
COPY package*.json ./

# Installer les dependances de production
RUN npm ci --only=production

# Copier le code source
COPY . .

# Creer les repertoires necessaires
RUN mkdir -p auth temp

# Exposer le port
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Demarrer avec PM2 runtime
CMD ["pm2-runtime", "ecosystem.config.cjs"]
