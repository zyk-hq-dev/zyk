FROM nginx:alpine
COPY index.html /etc/nginx/templates/index.html.template
COPY nginx.conf /etc/nginx/templates/default.conf.template
EXPOSE 8080
CMD ["/bin/sh", "-c", \
  "envsubst '$PORT' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf && \
   envsubst '$POSTHOG_KEY' < /etc/nginx/templates/index.html.template > /usr/share/nginx/html/index.html && \
   nginx -g 'daemon off;'"]
