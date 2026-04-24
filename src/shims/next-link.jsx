import React from 'react';
import { Link as RouterLink } from 'react-router-dom';

function stringifyHref(href) {
  if (typeof href === 'string') return href;
  if (href && typeof href === 'object') {
    const pathname = String(href.pathname || '');
    const search = href.search ? String(href.search) : '';
    const hash = href.hash ? String(href.hash) : '';
    return `${pathname}${search}${hash}` || '/';
  }
  return '/';
}

function isExternal(href) {
  return /^(https?:|mailto:|tel:|sms:|whatsapp:|viber:)/i.test(href || '');
}

const NextLink = React.forwardRef(function NextLink(
  { href = '/', children, replace = false, onClick, target, rel, ...rest },
  ref,
) {
  const to = stringifyHref(href);
  if (target || isExternal(to)) {
    return (
      <a ref={ref} href={to} target={target} rel={rel} onClick={onClick} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <RouterLink ref={ref} to={to} replace={replace} onClick={onClick} {...rest}>
      {children}
    </RouterLink>
  );
});

export default NextLink;
