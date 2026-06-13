import React from 'react';

export default function Script(props) {
  const { id, src, dangerouslySetInnerHTML, strategy, ...rest } = props || {};
  if (dangerouslySetInnerHTML) {
    return <script id={id} dangerouslySetInnerHTML={dangerouslySetInnerHTML} {...rest} />;
  }
  return <script id={id} src={src} {...rest} />;
}
