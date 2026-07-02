# Use the official Playwright Docker image which comes pre-installed with all browser dependencies
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Copy package.json and install Node dependencies
COPY package*.json ./
RUN npm ci

# Copy the rest of the API code
COPY . .

# Ensure the data directory exists so we can save cards.json
RUN mkdir -p data

# Expose the API port
EXPOSE 4000

# Start the server and the cron scheduler
CMD ["npm", "start"]
