FROM nginx:1.27-alpine

# Install certbot for Let's Encrypt support
RUN apk add --no-cache certbot certbot-nginx openssl

# Create directories
RUN mkdir -p /var/www/certbot /etc/nginx/certs

# Copy config
COPY nginx.conf /etc/nginx/nginx.conf
COPY conf.d/ /etc/nginx/conf.d/

EXPOSE 80 443

STOPSIGNAL SIGTERM

CMD ["nginx", "-g", "daemon off;"]
